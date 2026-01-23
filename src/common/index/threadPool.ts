// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import { Worker } from 'worker_threads';
import * as path from 'path';
import { SearchInput, SearchOutput, IndexInput, IndexOutput } from './types';

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

type QueuedTask = QueuedSearchTask | QueuedIndexTask;

/**
 * ThreadPoolManager manages a pool of worker threads for parallel content searching.
 * It handles task distribution, worker lifecycle, and error recovery.
 */
export class ThreadPoolManager {
    private workers: Worker[] = [];
    private availableWorkers: Worker[] = [];
    private taskQueue: QueuedTask[] = [];
    private workerTaskMap: Map<Worker, QueuedTask> = new Map();
    private disposed: boolean = false;

    /**
     * Create a new thread pool with the specified number of workers.
     *
     * @param numThreads - Number of worker threads to create
     */
    constructor(numThreads: number) {
        // Create worker pool
        for (let i = 0; i < numThreads; i++) {
            this.createWorker();
        }
    }

    /**
     * Create a new worker thread and add it to the pool.
     */
    private createWorker(): Worker {
        // Get the path to the compiled worker script
        // In development, this is relative to the compiled output
        const workerPath = path.join(__dirname, 'searchWorker.js');

        const worker = new Worker(workerPath);

        worker.on('message', (output: SearchOutput | IndexOutput) => {
            // Get the task that was being processed
            const task = this.workerTaskMap.get(worker);
            this.workerTaskMap.delete(worker);

            if (task) {
                // Type assertion based on task type
                if (task.type === 'index') {
                    task.resolve(output as IndexOutput);
                } else {
                    task.resolve(output as SearchOutput);
                }
            }

            // Return worker to pool and process next task
            if (!this.disposed) {
                this.availableWorkers.push(worker);
                this.processNextTask();
            }
        });

        worker.on('error', (error: Error) => {
            console.error(`Worker error: ${error.message}`);

            // Get the task that was being processed
            const task = this.workerTaskMap.get(worker);
            this.workerTaskMap.delete(worker);

            if (task) {
                // Return error result based on task type
                if (task.type === 'index') {
                    task.resolve({
                        type: 'index',
                        filePath: task.input.filePath,
                        lineStarts: null,
                        error: error.message
                    });
                } else {
                    task.resolve({
                        filePath: task.input.filePath,
                        results: [],
                        error: error.message
                    });
                }
            }

            // Remove crashed worker from pool
            const workerIndex = this.workers.indexOf(worker);
            if (workerIndex !== -1) {
                this.workers.splice(workerIndex, 1);
            }

            // Create a replacement worker if not disposed
            if (!this.disposed) {
                this.createWorker();
            }
        });

        worker.on('exit', (code: number) => {
            if (code !== 0 && !this.disposed) {
                console.warn(`Worker exited with code ${code}`);

                // Remove exited worker from available pool
                const availableIndex = this.availableWorkers.indexOf(worker);
                if (availableIndex !== -1) {
                    this.availableWorkers.splice(availableIndex, 1);
                }

                // Handle any pending task for this worker
                const task = this.workerTaskMap.get(worker);
                this.workerTaskMap.delete(worker);

                if (task) {
                    // Re-queue the task
                    this.taskQueue.unshift(task);
                }

                // Remove from workers array
                const workerIndex = this.workers.indexOf(worker);
                if (workerIndex !== -1) {
                    this.workers.splice(workerIndex, 1);
                }

                // Create a replacement worker
                this.createWorker();
            }
        });

        this.workers.push(worker);
        this.availableWorkers.push(worker);

        // Process any queued tasks
        this.processNextTask();

        return worker;
    }

    /**
     * Process the next task in the queue if a worker is available.
     */
    private processNextTask(): void {
        if (this.disposed) {
            return;
        }

        while (this.taskQueue.length > 0 && this.availableWorkers.length > 0) {
            const task = this.taskQueue.shift()!;
            const worker = this.availableWorkers.shift()!;

            this.workerTaskMap.set(worker, task);
            worker.postMessage(task.input);
        }
    }

    /**
     * Submit a search task to the pool.
     *
     * @param input - Search input containing file path, regex pattern, and line starts
     * @returns Promise that resolves with the search results
     */
    submit(input: SearchInput): Promise<SearchOutput> {
        if (this.disposed) {
            return Promise.resolve({
                filePath: input.filePath,
                results: [],
                error: 'Thread pool has been disposed'
            });
        }

        return new Promise((resolve, reject) => {
            this.taskQueue.push({ type: 'search', input, resolve, reject });
            this.processNextTask();
        });
    }

    /**
     * Submit an indexing task to the pool.
     *
     * @param input - Index input containing file path
     * @returns Promise that resolves with the index results
     */
    submitIndex(input: IndexInput): Promise<IndexOutput> {
        if (this.disposed) {
            return Promise.resolve({
                type: 'index',
                filePath: input.filePath,
                lineStarts: null,
                error: 'Thread pool has been disposed'
            });
        }

        return new Promise((resolve, reject) => {
            this.taskQueue.push({ type: 'index', input, resolve, reject });
            this.processNextTask();
        });
    }

    /**
     * Index multiple files in parallel.
     *
     * @param filePaths - Array of file paths to index
     * @returns Promise that resolves with all index results
     */
    async indexAll(filePaths: string[]): Promise<IndexOutput[]> {
        if (this.disposed) {
            return filePaths.map(filePath => ({
                type: 'index' as const,
                filePath,
                lineStarts: null,
                error: 'Thread pool has been disposed'
            }));
        }

        const inputs: IndexInput[] = filePaths.map(filePath => ({
            type: 'index' as const,
            filePath
        }));

        return Promise.all(inputs.map(input => this.submitIndex(input)));
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
                filePath: input.filePath,
                results: [],
                error: 'Thread pool has been disposed'
            }));
        }

        return Promise.all(inputs.map(input => this.submit(input)));
    }

    /**
     * Get the number of active workers.
     */
    getWorkerCount(): number {
        return this.workers.length;
    }

    /**
     * Get the number of available (idle) workers.
     */
    getAvailableWorkerCount(): number {
        return this.availableWorkers.length;
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
                    filePath: task.input.filePath,
                    lineStarts: null,
                    error: 'Thread pool disposed'
                });
            } else {
                task.resolve({
                    filePath: task.input.filePath,
                    results: [],
                    error: 'Thread pool disposed'
                });
            }
        }
        this.taskQueue = [];

        // Terminate all workers
        for (const worker of this.workers) {
            worker.terminate().catch(error => {
                console.warn(`Error terminating worker: ${error}`);
            });
        }

        this.workers = [];
        this.availableWorkers = [];
        this.workerTaskMap.clear();
    }
}
