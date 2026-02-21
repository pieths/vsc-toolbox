// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Worker thread script for parallel task execution.
 * This file runs in a separate worker thread.
 *
 * This module is bundled by esbuild into a standalone JS file, so imports
 * from other project files are resolved at build time.
 */

import { parentPort } from 'worker_threads';
import type {
    SearchInput,
    SearchOutput,
    IndexInput,
    IndexOutput,
    ComputeChunksInput,
    WorkerLogMessage,
} from '../types';
import { searchFile } from './tasks/searchFileTask';
import { indexFile } from './tasks/indexFileTask';
import { computeChunks } from './tasks/computeChunksTask';

/**
 * Send a log message from this worker thread to the main thread.
 * The ThreadPool will forward it to the extension logger.
 */
function workerLog(level: WorkerLogMessage['level'], message: string): void {
    parentPort?.postMessage({ type: 'log', level, message } satisfies WorkerLogMessage);
}

// Global error handlers to prevent worker crashes
process.on('uncaughtException', (error) => {
    workerLog('error', `Worker uncaught exception: ${error}`);
});
process.on('unhandledRejection', (reason) => {
    workerLog('error', `Worker unhandled rejection: ${reason}`);
});

// Listen for batch messages from WorkerHost
if (parentPort) {
    parentPort.on('message', async (msg: { type: string; inputs: any[] }) => {
        if (msg.type === 'searchBatch') {
            const inputs = msg.inputs as SearchInput[];
            const outputs: SearchOutput[] = [];
            for (const input of inputs) {
                outputs.push(await searchFile(input));
            }
            parentPort!.postMessage({ type: 'searchBatch', outputs });
        } else if (msg.type === 'indexBatch') {
            const inputs = msg.inputs as IndexInput[];
            const outputs: IndexOutput[] = [];
            for (const input of inputs) {
                outputs.push(await indexFile(input));
            }
            parentPort!.postMessage({ type: 'indexBatch', outputs });
        } else if (msg.type === 'computeChunksBatch') {
            const inputs = msg.inputs as ComputeChunksInput[];
            const outputs = [];
            for (const input of inputs) {
                outputs.push(await computeChunks(input));
            }
            parentPort!.postMessage({ type: 'computeChunksBatch', outputs });
        }
    });
}
