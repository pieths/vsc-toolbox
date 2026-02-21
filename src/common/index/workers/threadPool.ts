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
    WorkerBatchRequest,
    WorkerBatchResponse,
    WorkerInitResponse,
} from '../types';
import { debug, log, warn, error } from '../../logger';

/** Maximum time (ms) to wait for the child process to send init-ack */
const INIT_TIMEOUT_MS = 10000;

type ChildMessage = WorkerBatchResponse | WorkerLogMessage | WorkerInitResponse;

/**
 * ThreadPool is a thin IPC proxy that communicates with a WorkerHost
 * child process. The WorkerHost owns the actual worker threads and
 * handles task distribution internally.
 *
 * Each public "batch" method (searchAll, indexAll, computeChunksAll)
 * sends a single IPC message to the child process and receives a
 * single response, minimizing IPC overhead.
 */
export class ThreadPool {
    private childProcess: ChildProcess | null = null;
    private nextMessageId: number = 0;
    private pendingRequests: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }> = new Map();
    private maxConcurrency: number;
    private disposed: boolean = false;
    private initPromise: Promise<void>;
    private nodePath: string;

    /**
     * Create a new thread pool.
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

                // Batch response — correlate by messageId
                const pending = this.pendingRequests.get(msg.messageId);
                if (pending) {
                    this.pendingRequests.delete(msg.messageId);
                    pending.resolve(msg.outputs);
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
                    for (const [, pending] of this.pendingRequests) {
                        pending.reject(new Error(`Worker host process exited (code=${code})`));
                    }
                    this.pendingRequests.clear();

                    // Restart the child process
                    this.childProcess = null;
                    this.initPromise = this.spawnChild(this.maxConcurrency);
                }
            });

            // Send init message with thread count
            this.childProcess.send({ type: 'init', numThreads });
        });
    }

    /**
     * Send a batch request to the child process
     * and return a promise for the response.
     */
    private sendBatch(request: WorkerBatchRequest): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.childProcess?.connected) {
                reject(new Error('Child process not connected'));
                return;
            }

            this.pendingRequests.set(request.messageId, { resolve, reject });
            this.childProcess.send(request);
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

        await this.initPromise;

        const messageId = this.nextMessageId++;
        try {
            return await this.sendBatch({
                type: 'searchBatch',
                messageId,
                inputs,
            });
        } catch (err) {
            return inputs.map(input => ({
                type: 'search' as const,
                filePath: input.filePath,
                results: [],
                error: err instanceof Error ? err.message : String(err),
            }));
        }
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

        await this.initPromise;

        const messageId = this.nextMessageId++;
        try {
            const outputs: IndexOutput[] = await this.sendBatch({
                type: 'indexBatch',
                messageId,
                inputs,
            });

            // Log results
            for (const output of outputs) {
                if (output.status === IndexStatus.Indexed) {
                    log(`Content index: Indexed ${output.filePath}`);
                } else if (output.status === IndexStatus.Failed && output.error) {
                    error(`Content index: Failed to index ${output.filePath}: ${output.error}`);
                }
            }

            return outputs;
        } catch (err) {
            return inputs.map(input => ({
                type: 'index' as const,
                status: IndexStatus.Failed,
                filePath: input.filePath,
                tagsPath: null,
                error: err instanceof Error ? err.message : String(err),
            }));
        }
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

        await this.initPromise;

        const messageId = this.nextMessageId++;
        try {
            return await this.sendBatch({
                type: 'computeChunksBatch',
                messageId,
                inputs,
            });
        } catch (err) {
            return inputs.map(input => ({
                type: 'computeChunks' as const,
                filePath: input.filePath,
                chunks: [],
                error: err instanceof Error ? err.message : String(err),
            }));
        }
    }

    /**
     * Get the maximum concurrency (number of worker threads in the child process).
     */
    getWorkerCount(): number {
        return this.maxConcurrency;
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

        // Reject all in-flight requests
        for (const [, pending] of this.pendingRequests) {
            pending.reject(new Error('Thread pool disposed'));
        }
        this.pendingRequests.clear();

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
