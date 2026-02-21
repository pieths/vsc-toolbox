// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Worker Host — child process entry point.
 *
 * This process is forked by ThreadPool and owns a pool of worker threads.
 * It receives batch requests over IPC, splits work across threads,
 * collects results, and sends a single batch response back.
 *
 * Communication:
 *   ThreadPool  ──IPC (batch)──►  WorkerHost  ──postMessage (batch)──►  Worker threads
 *   ThreadPool  ◄──IPC (batch)──  WorkerHost  ◄──postMessage (batch)──  Worker threads
 */

import { Worker } from 'worker_threads';
import * as path from 'path';
import type {
    SearchInput,
    SearchOutput,
    IndexInput,
    IndexOutput,
    ComputeChunksInput,
    ComputeChunksOutput,
    WorkerLogMessage,
    WorkerInitRequest,
    WorkerShutdownRequest,
    SearchBatchRequest,
    IndexBatchRequest,
    ComputeChunksBatchRequest,
    WorkerBatchRequest,
} from '../types';

type ParentMessage = WorkerInitRequest | WorkerShutdownRequest | WorkerBatchRequest;

type WorkerPayloadInput =
    | { type: 'searchBatch'; inputs: SearchInput[] }
    | { type: 'indexBatch'; inputs: IndexInput[] }
    | { type: 'computeChunksBatch'; inputs: ComputeChunksInput[] };

type WorkerPayloadOutput =
    | { type: 'searchBatch'; outputs: SearchOutput[] }
    | { type: 'indexBatch'; outputs: IndexOutput[] }
    | { type: 'computeChunksBatch'; outputs: ComputeChunksOutput[] };

type WorkerMessage = WorkerPayloadOutput | WorkerLogMessage;

// ── State ─────────────────────────────────────────────────────────────

const workers: Worker[] = [];
let numThreads = 0;

// ── Worker lifecycle ──────────────────────────────────────────────────

function createWorker(): Worker {
    const workerPath = path.join(__dirname, 'workerThread.js');
    const worker = new Worker(workerPath);

    worker.on('error', (err: Error) => {
        process.send?.({
            type: 'log',
            level: 'error',
            message: `[WorkerHost] Worker error: ${err.message}`,
        });

        // Remove and replace the crashed worker
        const idx = workers.indexOf(worker);
        if (idx !== -1) {
            workers.splice(idx, 1);
        }
        workers.push(createWorker());
    });

    worker.on('exit', (code: number) => {
        if (code !== 0) {
            process.send?.({
                type: 'log',
                level: 'warn',
                message: `[WorkerHost] Worker exited with code ${code}`,
            });

            const idx = workers.indexOf(worker);
            if (idx !== -1) {
                workers.splice(idx, 1);
            }
            workers.push(createWorker());
        }
    });

    return worker;
}

// ── Batch processing ──────────────────────────────────────────────────

/**
 * Split an array into N roughly equal chunks.
 */
function splitIntoChunks<T>(array: T[], n: number): T[][] {
    if (n <= 0) { return [array]; }
    const chunks: T[][] = [];
    const chunkSize = Math.ceil(array.length / n);
    for (let i = 0; i < array.length; i += chunkSize) {
        chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
}

/**
 * Dispatch a batch of search inputs across all worker threads.
 * Each worker receives a sub-batch and returns its results.
 */
function handleSearchBatch(request: SearchBatchRequest): void {
    const { messageId, inputs } = request;

    if (inputs.length === 0) {
        process.send?.({ type: 'searchBatch', messageId, outputs: [] });
        return;
    }

    const chunks = splitIntoChunks(inputs, workers.length);
    let completedWorkers = 0;
    const allOutputs: SearchOutput[][] = new Array(chunks.length);

    for (let i = 0; i < chunks.length; i++) {
        const worker = workers[i];
        const payload: WorkerPayloadInput = { type: 'searchBatch', inputs: chunks[i] };

        const onMessage = (msg: WorkerMessage) => {
            if (msg.type === 'log') {
                process.send?.(msg);
                return;
            }

            if (msg.type === 'searchBatch') {
                worker.removeListener('message', onMessage);
                allOutputs[i] = msg.outputs;
                completedWorkers++;

                if (completedWorkers === chunks.length) {
                    const outputs = allOutputs.flat();
                    process.send?.({ type: 'searchBatch', messageId, outputs });
                }
            }
        };

        worker.on('message', onMessage);
        worker.postMessage(payload);
    }
}

/**
 * Dispatch a batch of index inputs across all worker threads.
 */
function handleIndexBatch(request: IndexBatchRequest): void {
    const { messageId, inputs } = request;

    if (inputs.length === 0) {
        process.send?.({ type: 'indexBatch', messageId, outputs: [] });
        return;
    }

    const chunks = splitIntoChunks(inputs, workers.length);
    let completedWorkers = 0;
    const allOutputs: IndexOutput[][] = new Array(chunks.length);

    for (let i = 0; i < chunks.length; i++) {
        const worker = workers[i];
        const payload: WorkerPayloadInput = { type: 'indexBatch', inputs: chunks[i] };

        const onMessage = (msg: WorkerMessage) => {
            if (msg.type === 'log') {
                process.send?.(msg);
                return;
            }

            if (msg.type === 'indexBatch') {
                worker.removeListener('message', onMessage);
                allOutputs[i] = msg.outputs;
                completedWorkers++;

                if (completedWorkers === chunks.length) {
                    const outputs = allOutputs.flat();
                    process.send?.({ type: 'indexBatch', messageId, outputs });
                }
            }
        };

        worker.on('message', onMessage);
        worker.postMessage(payload);
    }
}

/**
 * Dispatch a batch of compute chunks inputs across all worker threads.
 */
function handleComputeChunksBatch(request: ComputeChunksBatchRequest): void {
    const { messageId, inputs } = request;

    if (inputs.length === 0) {
        process.send?.({ type: 'computeChunksBatch', messageId, outputs: [] });
        return;
    }

    const chunks = splitIntoChunks(inputs, workers.length);
    let completedWorkers = 0;
    const allOutputs: ComputeChunksOutput[][] = new Array(chunks.length);

    for (let i = 0; i < chunks.length; i++) {
        const worker = workers[i];
        const payload: WorkerPayloadInput = { type: 'computeChunksBatch', inputs: chunks[i] };

        const onMessage = (msg: WorkerMessage) => {
            if (msg.type === 'log') {
                process.send?.(msg);
                return;
            }

            if (msg.type === 'computeChunksBatch') {
                worker.removeListener('message', onMessage);
                allOutputs[i] = msg.outputs;
                completedWorkers++;

                if (completedWorkers === chunks.length) {
                    const outputs = allOutputs.flat();
                    process.send?.({ type: 'computeChunksBatch', messageId, outputs });
                }
            }
        };

        worker.on('message', onMessage);
        worker.postMessage(payload);
    }
}

// ── IPC from ThreadPool ───────────────────────────────────────────────

process.on('message', (msg: ParentMessage) => {
    if (msg.type === 'init') {
        // Initialize worker threads
        numThreads = msg.numThreads;
        for (let i = 0; i < numThreads; i++) {
            workers.push(createWorker());
        }
        // Acknowledge init
        process.send?.({ type: 'init-ack', numThreads });
        return;
    }

    if (msg.type === 'shutdown') {
        // Gracefully terminate all workers
        const terminatePromises = workers.map(w => w.terminate());
        Promise.all(terminatePromises).finally(() => {
            process.exit(0);
        });
        return;
    }

    // Batch requests
    if (msg.type === 'searchBatch') {
        handleSearchBatch(msg);
    } else if (msg.type === 'indexBatch') {
        handleIndexBatch(msg);
    } else if (msg.type === 'computeChunksBatch') {
        handleComputeChunksBatch(msg);
    }
});

// ── Global error handlers ─────────────────────────────────────────────

process.on('uncaughtException', (err) => {
    console.error('[WorkerHost] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('[WorkerHost] Unhandled rejection:', reason);
});
