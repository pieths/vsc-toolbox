// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import { Worker } from 'worker_threads';
import * as path from 'path';
import {
    SearchOutput,
    IndexInput,
    IndexOutput,
    IndexStatus,
    ComputeChunksInput,
    ComputeChunksOutput,
    ComputeChunksStatus,
    WorkerLogMessage,
    WorkerBatchResponse,
    SearchBatchRequest,
    IndexBatchRequest,
    ComputeChunksBatchRequest,
} from '../types';
import type { FileScrubPatterns } from '../fileScrubber';
import { debug, log, warn, error } from '../../logger';

type WorkerMessage = WorkerBatchResponse | WorkerLogMessage;

/**
 * ThreadPool owns a set of worker threads and distributes batch
 * work across them. Each public method (searchAll, indexAll,
 * computeChunksAll) splits inputs into per-worker sub-batches,
 * dispatches them via postMessage, and merges the results.
 */
export class ThreadPool {
    private workers: Worker[] = [];
    private nextMessageId: number = 0;
    private maxConcurrency: number;
    private disposed: boolean = false;

    /**
     * Create a new thread pool.
     *
     * @param numThreads - Number of worker threads to create
     */
    constructor(numThreads: number) {
        this.maxConcurrency = numThreads;

        for (let i = 0; i < numThreads; i++) {
            this.workers.push(this.createWorker());
        }

        log(`[ThreadPool] Started with ${numThreads} worker threads`);
    }

    // ── Worker lifecycle ──────────────────────────────────────────────

    private createWorker(): Worker {
        const workerPath = path.join(__dirname, 'workerThread.js');
        const worker = new Worker(workerPath);

        worker.on('error', (err: Error) => {
            error(`[ThreadPool] Worker error: ${err.message}`);
        });

        // The 'exit' event always fires (including after 'error'),
        // so all removal and replacement logic lives here.
        worker.on('exit', (code: number) => {
            const idx = this.workers.indexOf(worker);
            if (idx !== -1) {
                this.workers.splice(idx, 1);
            }

            if (code !== 0 && !this.disposed) {
                warn(`[ThreadPool] Worker exited with code ${code}, replacing...`);
                this.workers.push(this.createWorker());
            }
        });

        return worker;
    }

    // ── Utilities ─────────────────────────────────────────────────────

    /**
     * Split an array into N roughly equal chunks.
     */
    private splitIntoChunks<T>(array: T[], n: number): T[][] {
        if (n <= 0) { return [array]; }
        const chunks: T[][] = [];
        const chunkSize = Math.ceil(array.length / n);
        for (let i = 0; i < array.length; i += chunkSize) {
            chunks.push(array.slice(i, i + chunkSize));
        }
        return chunks;
    }

    /**
     * Forward a worker log message to the extension logger.
     */
    private handleLogMessage(msg: WorkerLogMessage): void {
        const text = `[Worker] ${msg.message}`;
        switch (msg.level) {
            case 'debug': debug(text); break;
            case 'info': log(text); break;
            case 'warn': warn(text); break;
            case 'error': error(text); break;
        }
    }

    // ── Public API ────────────────────────────────────────────────────

    /**
     * Search multiple files in parallel.
     *
     * @param query - Glob query string
     * @param filePaths - Absolute file paths to search
     * @param isRegexp - When true, treat query as a single regex pattern
     * @returns Promise that resolves with search results (only files with matches)
     */
    async searchAll(query: string, filePaths: string[], isRegexp: boolean): Promise<SearchOutput[]> {
        if (this.disposed || filePaths.length === 0) {
            return [];
        }

        const messageId = this.nextMessageId++;
        const chunks = this.splitIntoChunks(filePaths, this.workers.length);
        const allOutputs: SearchOutput[][] = new Array(chunks.length);
        let completedWorkers = 0;

        return new Promise<SearchOutput[]>((resolve) => {
            for (let i = 0; i < chunks.length; i++) {
                const worker = this.workers[i];

                const onMessage = (msg: WorkerMessage) => {
                    if (msg.type === 'log') {
                        this.handleLogMessage(msg);
                        return;
                    }

                    if (msg.type === 'searchBatch' && msg.messageId === messageId) {
                        worker.removeListener('message', onMessage);
                        allOutputs[i] = msg.outputs;
                        completedWorkers++;

                        if (completedWorkers === chunks.length) {
                            resolve(allOutputs.flat());
                        }
                    }
                };

                worker.on('message', onMessage);
                const request: SearchBatchRequest = {
                    type: 'searchBatch', messageId, query, filePaths: chunks[i], isRegexp,
                };
                worker.postMessage(request);
            }
        });
    }

    /**
     * Index multiple files in parallel.
     *
     * @param inputs - Array of index inputs to process
     * @param preParseScrubPatterns - Glob → regex-string[] map applied to each
     *     file's source before parsing. Identical for every input;
     *     forwarded to workers via the batch request.
     * @returns Promise that resolves with all index results
     */
    async indexAll(
        inputs: IndexInput[],
        preParseScrubPatterns: FileScrubPatterns = {},
    ): Promise<IndexOutput[]> {
        if (this.disposed) {
            return inputs.map(input => ({
                type: 'index' as const,
                status: IndexStatus.Failed,
                filePath: input.filePath,
                idxPath: null,
                error: 'Thread pool has been disposed'
            }));
        }

        if (inputs.length === 0) {
            return [];
        }

        const messageId = this.nextMessageId++;
        const chunks = this.splitIntoChunks(inputs, this.workers.length);
        const allOutputs: IndexOutput[][] = new Array(chunks.length);
        let completedWorkers = 0;

        try {
            const outputs = await new Promise<IndexOutput[]>((resolve) => {
                for (let i = 0; i < chunks.length; i++) {
                    const worker = this.workers[i];

                    const onMessage = (msg: WorkerMessage) => {
                        if (msg.type === 'log') {
                            this.handleLogMessage(msg);
                            return;
                        }

                        if (msg.type === 'indexBatch' && msg.messageId === messageId) {
                            worker.removeListener('message', onMessage);
                            allOutputs[i] = msg.outputs;
                            completedWorkers++;

                            if (completedWorkers === chunks.length) {
                                resolve(allOutputs.flat());
                            }
                        }
                    };

                    worker.on('message', onMessage);
                    const request: IndexBatchRequest = {
                        type: 'indexBatch',
                        messageId,
                        inputs: chunks[i],
                        preParseScrubPatterns
                    };
                    worker.postMessage(request);
                }
            });

            // Log results
            const indexed: string[] = [];
            const deleted: string[] = [];
            for (const output of outputs) {
                if (output.status === IndexStatus.Indexed) {
                    indexed.push(output.filePath);
                } else if (output.status === IndexStatus.Deleted) {
                    deleted.push(output.filePath);
                } else if (output.status === IndexStatus.Failed && output.error) {
                    error(`Content index: Failed to index ${output.filePath}: ${output.error}`);
                }
            }
            if (indexed.length > 0) {
                log(`Content index: Indexed ${indexed.length} files:\n  ${indexed.join('\n  ')}`);
            }
            if (deleted.length > 0) {
                log(`Content index: Deleted ${deleted.length} index files:\n  ${deleted.join('\n  ')}`);
            }

            return outputs;
        } catch (err) {
            return inputs.map(input => ({
                type: 'index' as const,
                status: IndexStatus.Failed,
                filePath: input.filePath,
                idxPath: null,
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
                status: ComputeChunksStatus.Error,
                filePath: input.filePath,
                chunks: [],
                error: 'Thread pool has been disposed'
            }));
        }

        if (inputs.length === 0) {
            return [];
        }

        const messageId = this.nextMessageId++;
        const chunks = this.splitIntoChunks(inputs, this.workers.length);
        const allOutputs: ComputeChunksOutput[][] = new Array(chunks.length);
        let completedWorkers = 0;

        try {
            return await new Promise<ComputeChunksOutput[]>((resolve) => {
                for (let i = 0; i < chunks.length; i++) {
                    const worker = this.workers[i];

                    const onMessage = (msg: WorkerMessage) => {
                        if (msg.type === 'log') {
                            this.handleLogMessage(msg);
                            return;
                        }

                        if (msg.type === 'computeChunksBatch' && msg.messageId === messageId) {
                            worker.removeListener('message', onMessage);
                            allOutputs[i] = msg.outputs;
                            completedWorkers++;

                            if (completedWorkers === chunks.length) {
                                resolve(allOutputs.flat());
                            }
                        }
                    };

                    worker.on('message', onMessage);
                    const request: ComputeChunksBatchRequest = {
                        type: 'computeChunksBatch', messageId, inputs: chunks[i],
                    };
                    worker.postMessage(request);
                }
            });
        } catch (err) {
            return inputs.map(input => ({
                type: 'computeChunks' as const,
                status: ComputeChunksStatus.Error,
                filePath: input.filePath,
                chunks: [],
                error: err instanceof Error ? err.message : String(err),
            }));
        }
    }

    /**
     * Get the maximum concurrency (number of worker threads).
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
     * Shutdown all worker threads and clean up resources.
     */
    async dispose(): Promise<void> {
        if (this.disposed) {
            return;
        }

        this.disposed = true;

        await Promise.all(this.workers.map(w => w.terminate()));
        this.workers = [];

        log('[ThreadPool] All worker threads stopped');
    }
}
