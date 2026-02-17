// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Worker Host — child process entry point.
 *
 * This process is forked by ThreadPool and owns a pool of worker threads.
 * It relays messages between the IPC channel (to the Extension Host) and
 * the worker threads.
 *
 * Communication:
 *   ThreadPool  ──IPC──►  WorkerHost  ──postMessage──►  Worker threads
 *   ThreadPool  ◄──IPC──  WorkerHost  ◄──postMessage──  Worker threads
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
    WorkerTaskRequest,
    WorkerTaskResponse,
} from '../types';

type ParentMessage = WorkerInitRequest | WorkerShutdownRequest | WorkerTaskRequest;

type WorkerPayloadInput = SearchInput | IndexInput | ComputeChunksInput;
type WorkerPayloadOutput = SearchOutput | IndexOutput | ComputeChunksOutput;

type WorkerMessage = WorkerPayloadOutput | WorkerLogMessage;

interface QueuedRequest {
    messageId: number;
    payload: WorkerPayloadInput;
}

// ── State ─────────────────────────────────────────────────────────────

const workers: Worker[] = [];
const idleWorkers: Worker[] = [];
const requestQueue: QueuedRequest[] = [];

/** Maps a Worker to the messageId it is currently processing. */
const workerMessageMap = new Map<Worker, number>();

let numThreads = 0;

// ── Worker lifecycle ──────────────────────────────────────────────────

function createWorker(): Worker {
    const workerPath = path.join(__dirname, 'workerThread.js');
    const worker = new Worker(workerPath);

    worker.on('message', (msg: WorkerMessage) => {
        // Forward log messages straight to the parent (fire-and-forget)
        if (msg.type === 'log') {
            const logMsg = msg as WorkerLogMessage;
            process.send?.({
                type: 'log',
                level: logMsg.level,
                message: logMsg.message,
            });
            return;
        }

        const messageId = workerMessageMap.get(worker);
        workerMessageMap.delete(worker);

        if (messageId !== undefined) {
            const response: WorkerTaskResponse = {
                type: 'taskResponse',
                messageId,
                payload: msg as WorkerPayloadOutput,
            };
            process.send?.(response);
        }

        // Return worker to idle pool and drain queue
        idleWorkers.push(worker);
        drainQueue();
    });

    worker.on('error', (err: Error) => {
        process.send?.({
            type: 'log',
            level: 'error',
            message: `[WorkerHost] Worker error: ${err.message}`,
        });

        const messageId = workerMessageMap.get(worker);
        workerMessageMap.delete(worker);

        // Remove from arrays
        removeWorker(worker);

        // If a task was in-flight, re-queue it
        if (messageId !== undefined) {
            // Find the original payload — we stored it nowhere, so we must
            // send an error response back instead. (The ThreadPool will handle it.)
            // We can't recover the payload, so send an error response.
            const errorResponse: WorkerTaskResponse = {
                type: 'taskResponse',
                messageId,
                payload: { type: 'error', error: err.message } as any,
            };
            process.send?.(errorResponse);
        }

        // Replace the crashed worker
        createWorker();
    });

    worker.on('exit', (code: number) => {
        if (code !== 0) {
            process.send?.({
                type: 'log',
                level: 'warn',
                message: `[WorkerHost] Worker exited with code ${code}`,
            });

            const messageId = workerMessageMap.get(worker);
            workerMessageMap.delete(worker);

            removeWorker(worker);

            // Re-queue in-flight task if possible
            if (messageId !== undefined) {
                const errorResponse: WorkerTaskResponse = {
                    type: 'taskResponse',
                    messageId,
                    payload: { type: 'error', error: `Worker exited with code ${code}` } as any,
                };
                process.send?.(errorResponse);
            }

            // Replace the exited worker
            createWorker();
        }
    });

    workers.push(worker);
    idleWorkers.push(worker);
    drainQueue();

    return worker;
}

function removeWorker(worker: Worker): void {
    const idx = workers.indexOf(worker);
    if (idx !== -1) {
        workers.splice(idx, 1);
    }

    const idleIdx = idleWorkers.indexOf(worker);
    if (idleIdx !== -1) {
        idleWorkers.splice(idleIdx, 1);
    }
}

// ── Queue processing ──────────────────────────────────────────────────

function drainQueue(): void {
    while (requestQueue.length > 0 && idleWorkers.length > 0) {
        const request = requestQueue.shift()!;
        const worker = idleWorkers.shift()!;

        workerMessageMap.set(worker, request.messageId);
        worker.postMessage(request.payload);
    }
}

// ── IPC from ThreadPool ───────────────────────────────────────────────

process.on('message', (msg: ParentMessage) => {
    if (msg.type === 'init') {
        // Initialize worker threads
        numThreads = msg.numThreads;
        for (let i = 0; i < numThreads; i++) {
            createWorker();
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

    // Normal work request
    requestQueue.push(msg);
    drainQueue();
});

// ── Global error handlers ─────────────────────────────────────────────

process.on('uncaughtException', (err) => {
    console.error('[WorkerHost] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('[WorkerHost] Unhandled rejection:', reason);
});
