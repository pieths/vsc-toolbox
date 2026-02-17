// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import { fork, ChildProcess } from 'child_process';
import * as path from 'path';
import {
    SearchInput,
    SearchOutput,
    IndexInput,
    IndexOutput,
    IndexStatus,
    ComputeChunksInput,
    ComputeChunksOutput,
    WorkerLogMessage,
    WorkerTaskRequest,
    WorkerTaskResponse,
    WorkerInitResponse,
} from '../types';
import { debug, log, warn, error } from '../../logger';

/** Maximum time (ms) to wait for the child process to send init-ack */
const INIT_TIMEOUT_MS = 10000;

/**
 * Represents a search task in the queue waiting to be processed
 */
interface QueuedSearchTask {
    type: 'search';
    input: SearchInput;
    resolve: (output: SearchOutput) => void;
    reject: (error: Error) => void;
}

/**
 * Represents an indexing task in the queue waiting to be processed
 */
interface QueuedIndexTask {
    type: 'index';
    input: IndexInput;
    resolve: (output: IndexOutput) => void;
    reject: (error: Error) => void;
}

/**
 * Represents a compute chunks task in the queue waiting to be processed
 */
interface QueuedComputeChunksTask {
    type: 'computeChunks';
    input: ComputeChunksInput;
    resolve: (output: ComputeChunksOutput) => void;
    reject: (error: Error) => void;
}

type QueuedTask = QueuedSearchTask | QueuedIndexTask | QueuedComputeChunksTask;

/**
 * ThreadPool manages a pool of worker threads running in a dedicated child
 * process. This isolates heavy computation (ctags, tree-sitter WASM parsing,
 * file search, chunk computation) from the Extension Host process, preventing
 * memory pressure on other extensions.
 *
 * Communication with the child process uses JSON over a named pipe (IPC).
 */
export class ThreadPool {
    private childProcess: ChildProcess | null = null;
    private nextMessageId: number = 0;
    private pendingRequests: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }> = new Map();
    private activeCount: number = 0;
    private maxConcurrency: number;
    private taskQueue: QueuedTask[] = [];
    private pendingIndexTasks: Map<string, Promise<IndexOutput>> = new Map();
    private disposed: boolean = false;
    private initPromise: Promise<void>;
    private nodePath: string;

    /**
     * Create a new thread pool with the specified number of workers.
     * Forks a child process (WorkerHost) that owns the actual worker threads.
     *
     * @param numThreads - Number of worker threads to create in the child process
     * @param nodePath - Absolute path to standalone Node.js binary (avoids Electron's memory limits)
     */
    constructor(numThreads: number, nodePath: string) {
        this.maxConcurrency = numThreads;
        this.nodePath = nodePath;
        this.initPromise = this.spawnChild(numThreads);
    }

    /**
     * Fork the WorkerHost child process and wait for it to acknowledge init.
     */
    private spawnChild(numThreads: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const hostPath = path.join(__dirname, 'workerHost.js');

            // fork() defaults to process.execPath which, inside VS Code's
            // extension host, points to Electron (Code.exe). Electron caps
            // memory at relatively conservative values. Using a standalone
            // Node.js binary removes that limit, allowing the child process
            // to allocate more memory if needed.
            this.childProcess = fork(hostPath, [], {
                execPath: this.nodePath,
                stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
                windowsHide: true,
            } as any);

            type ChildMessage = WorkerTaskResponse | WorkerLogMessage | WorkerInitResponse;

            const initTimeout = setTimeout(() => {
                error(`[ThreadPool] Child process did not acknowledge init within ${INIT_TIMEOUT_MS}ms. Killing...`);
                try {
                    this.childProcess?.kill();
                } catch {
                    // Already dead
                }
                reject(new Error(`Worker host init timed out after ${INIT_TIMEOUT_MS}ms`));
            }, INIT_TIMEOUT_MS);

            const onInitAck = (msg: ChildMessage) => {
                if (msg.type === 'init-ack') {
                    clearTimeout(initTimeout);
                    this.childProcess!.removeListener('message', onInitAck);
                    log(`[ThreadPool] Worker host started with ${msg.numThreads} threads`);
                    resolve();
                }
            };

            this.childProcess.on('message', onInitAck);

            this.childProcess.on('message', (msg: ChildMessage) => {
                // Handle init-ack (already handled above for first time)
                if (msg.type === 'init-ack') {
                    return;
                }

                // Handle log messages forwarded from workers
                if (msg.type === 'log') {
                    const text = `[Worker] ${msg.message}`;
                    switch (msg.level) {
                        case 'debug': debug(text); break;
                        case 'info': log(text); break;
                        case 'warn': warn(text); break;
                        case 'error': error(text); break;
                    }
                    return;
                }

                // Normal response — correlate by messageId
                const pending = this.pendingRequests.get(msg.messageId);
                if (pending) {
                    this.pendingRequests.delete(msg.messageId);
                    this.activeCount--;
                    pending.resolve(msg.payload);
                    this.processNextTask();
                }
            });

            this.childProcess.on('error', (err: Error) => {
                clearTimeout(initTimeout);
                error(`[ThreadPool] Child process error: ${err.message}`);
                reject(err);
            });

            this.childProcess.on('exit', (code: number | null, signal: string | null) => {
                if (!this.disposed) {
                    warn(`[ThreadPool] Child process exited unexpectedly (code=${code}, signal=${signal}). Restarting...`);

                    // Reject all in-flight requests
                    for (const [id, pending] of this.pendingRequests) {
                        pending.reject(new Error(`Worker host process exited (code=${code})`));
                    }
                    this.pendingRequests.clear();
                    this.activeCount = 0;

                    // Restart the child process
                    this.childProcess = null;
                    this.initPromise = this.spawnChild(this.maxConcurrency);
                    this.initPromise
                        .then(() => this.processNextTask())
                        .catch((err) => error(`[ThreadPool] Failed to restart child process: ${err.message}`));
                }
            });

            // Send init message with thread count
            this.childProcess.send({ type: 'init', numThreads });
        });
    }

    /**
     * Process the next task in the queue if concurrency allows.
     */
    private processNextTask(): void {
        if (this.disposed) {
            return;
        }

        while (this.taskQueue.length > 0 && this.activeCount < this.maxConcurrency) {
            const task = this.taskQueue.shift()!;
            this.sendTask(task);
        }
    }

    /**
     * Send a task to the child process over IPC.
     */
    private sendTask(task: QueuedTask): void {
        if (!this.childProcess?.connected) {
            // Child not ready — re-queue
            this.taskQueue.unshift(task);
            return;
        }

        const messageId = this.nextMessageId++;
        this.activeCount++;

        this.pendingRequests.set(messageId, {
            resolve: (payload: any) => {
                if (task.type === 'index') {
                    task.resolve(payload as IndexOutput);
                } else if (task.type === 'computeChunks') {
                    task.resolve(payload as ComputeChunksOutput);
                } else if (task.type === 'search') {
                    task.resolve(payload as SearchOutput);
                }
            },
            reject: (err: Error) => {
                if (task.type === 'index') {
                    task.resolve({
                        type: 'index',
                        status: IndexStatus.Failed,
                        filePath: task.input.filePath,
                        tagsPath: null,
                        error: err.message,
                    });
                } else if (task.type === 'computeChunks') {
                    task.resolve({
                        type: 'computeChunks',
                        filePath: task.input.filePath,
                        chunks: [],
                        error: err.message,
                    });
                } else if (task.type === 'search') {
                    task.resolve({
                        type: 'search',
                        filePath: task.input.filePath,
                        results: [],
                        error: err.message,
                    });
                }
            },
        });

        const request: WorkerTaskRequest = {
            type: 'taskRequest',
            messageId,
            payload: task.input,
        };
        this.childProcess.send(request);
    }

    /**
     * Submit a search task to the pool.
     *
     * @param input - Search input containing file path, regex pattern, and line starts
     * @returns Promise that resolves with the search results
     */
    private submitSearch(input: SearchInput): Promise<SearchOutput> {
        if (this.disposed) {
            return Promise.resolve({
                type: 'search',
                filePath: input.filePath,
                results: [],
                error: 'Thread pool has been disposed'
            });
        }

        return new Promise((resolve, reject) => {
            this.taskQueue.push({ type: 'search', input, resolve, reject });
            this.initPromise
                .then(() => this.processNextTask())
                .catch(() => { }); // Errors handled by exit/error handlers
        });
    }

    /**
     * Search multiple files in parallel.
     *
     * @param inputs - Array of search inputs to process
     * @returns Promise that resolves with all search results
     */
    async searchAll(inputs: SearchInput[]): Promise<SearchOutput[]> {
        if (this.disposed) {
            return inputs.map(input => ({
                type: 'search' as const,
                filePath: input.filePath,
                results: [],
                error: 'Thread pool has been disposed'
            }));
        }

        return Promise.all(inputs.map(input => this.submitSearch(input)));
    }

    /**
     * Submit an indexing task to the pool.
     * If an identical request (same file path) is already in progress,
     * returns the existing promise instead of creating a duplicate task.
     *
     * @param input - Index input containing file path
     * @returns Promise that resolves with the index results
     */
    private submitIndex(input: IndexInput): Promise<IndexOutput> {
        if (this.disposed) {
            return Promise.resolve({
                type: 'index',
                status: IndexStatus.Failed,
                filePath: input.filePath,
                tagsPath: null,
                error: 'Thread pool has been disposed'
            });
        }

        // Check if there's already a pending request for this file
        const existing = this.pendingIndexTasks.get(input.filePath);
        if (existing) {
            return existing;
        }

        const promise = new Promise<IndexOutput>((resolve, reject) => {
            this.taskQueue.push({ type: 'index', input, resolve, reject });
            this.initPromise
                .then(() => this.processNextTask())
                .catch(() => { }); // Errors handled by exit/error handlers
        }).then(output => {
            if (output.status === IndexStatus.Indexed) {
                // Log once per file when indexing completes
                log(`Content index: Indexed ${output.filePath}`);
            } else if (output.status == IndexStatus.Failed && output.error) {
                error(`Content index: Failed to index ${output.filePath}: ${output.error}`);
            }
            return output;
        });

        // Store promise so subsequent calls can reuse it
        this.pendingIndexTasks.set(input.filePath, promise);

        // Clean up when done (whether success or failure)
        promise.finally(() => {
            this.pendingIndexTasks.delete(input.filePath);
        });

        return promise;
    }

    /**
     * Index multiple files in parallel.
     *
     * @param inputs - Array of index inputs to process
     * @returns Promise that resolves with all index results
     */
    async indexAll(inputs: IndexInput[]): Promise<IndexOutput[]> {
        if (this.disposed) {
            return inputs.map(input => ({
                type: 'index' as const,
                status: IndexStatus.Failed,
                filePath: input.filePath,
                tagsPath: null,
                error: 'Thread pool has been disposed'
            }));
        }

        return Promise.all(inputs.map(input => this.submitIndex(input)));
    }

    /**
     * Submit a compute chunks task to the pool.
     *
     * @param input - Compute chunks input containing file path and ctags path
     * @returns Promise that resolves with the computed chunks
     */
    private submitComputeChunks(input: ComputeChunksInput): Promise<ComputeChunksOutput> {
        if (this.disposed) {
            return Promise.resolve({
                type: 'computeChunks',
                filePath: input.filePath,
                chunks: [],
                error: 'Thread pool has been disposed'
            });
        }

        return new Promise((resolve, reject) => {
            this.taskQueue.push({ type: 'computeChunks', input, resolve, reject });
            this.initPromise
                .then(() => this.processNextTask())
                .catch(() => { }); // Errors handled by exit/error handlers
        });
    }

    /**
     * Compute chunks for multiple files in parallel.
     *
     * @param inputs - Array of compute chunks inputs to process
     * @returns Promise that resolves with all computed chunks
     */
    async computeChunksAll(inputs: ComputeChunksInput[]): Promise<ComputeChunksOutput[]> {
        if (this.disposed) {
            return inputs.map(input => ({
                type: 'computeChunks' as const,
                filePath: input.filePath,
                chunks: [],
                error: 'Thread pool has been disposed'
            }));
        }

        return Promise.all(inputs.map(input => this.submitComputeChunks(input)));
    }

    /**
     * Get the maximum concurrency (number of worker threads in the child process).
     */
    getWorkerCount(): number {
        return this.maxConcurrency;
    }

    /**
     * Get the number of available (idle) worker slots.
     */
    getAvailableWorkerCount(): number {
        return this.maxConcurrency - this.activeCount;
    }

    /**
     * Get the number of tasks waiting in the queue.
     */
    getQueueLength(): number {
        return this.taskQueue.length;
    }

    /**
     * Check if the thread pool has been disposed.
     */
    isDisposed(): boolean {
        return this.disposed;
    }

    /**
     * Shutdown all workers and clean up resources.
     */
    dispose(): void {
        if (this.disposed) {
            return;
        }

        this.disposed = true;

        // Reject any pending tasks based on their type
        for (const task of this.taskQueue) {
            if (task.type === 'index') {
                task.resolve({
                    type: 'index',
                    status: IndexStatus.Failed,
                    filePath: task.input.filePath,
                    tagsPath: null,
                    error: 'Thread pool disposed'
                });
            } else if (task.type === 'computeChunks') {
                task.resolve({
                    type: 'computeChunks',
                    filePath: task.input.filePath,
                    chunks: [],
                    error: 'Thread pool disposed'
                });
            } else if (task.type === 'search') {
                task.resolve({
                    type: 'search',
                    filePath: task.input.filePath,
                    results: [],
                    error: 'Thread pool disposed'
                });
            }
        }
        this.taskQueue = [];

        // Reject all in-flight requests
        for (const [id, pending] of this.pendingRequests) {
            pending.reject(new Error('Thread pool disposed'));
        }
        this.pendingRequests.clear();
        this.pendingIndexTasks.clear();

        // Send shutdown message and kill child process
        if (this.childProcess?.connected) {
            try {
                this.childProcess.send({ type: 'shutdown' });
            } catch {
                // Ignore send errors during shutdown
            }
        }

        // Force-kill after a brief grace period
        if (this.childProcess) {
            const cp = this.childProcess;
            this.childProcess = null;
            setTimeout(() => {
                try {
                    cp.kill();
                } catch {
                    // Already dead
                }
            }, 2000);
        }
    }
}
