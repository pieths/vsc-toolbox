// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Logger for worker threads.
 *
 * Provides a `workerLog` function that task code can import to send log
 * messages without a direct dependency on `parentPort`.  The actual
 * transport is wired up by `workerThread.ts` at startup via
 * `setLogHandler`, keeping the tasks easy to unit-test with a mock handler.
 */

import type { WorkerLogMessage } from '../types';

/** Signature for the function that delivers a log message. */
export type LogHandler = (level: WorkerLogMessage['level'], message: string) => void;

/** Current handler – no-op until `setLogHandler` is called. */
let handler: LogHandler = () => {};

/**
 * Install the handler that delivers log messages (typically via `parentPort`).
 * Must be called once when the worker thread starts.
 */
export function setLogHandler(fn: LogHandler): void {
    handler = fn;
}

/**
 * Send a log message from this worker thread to the main thread.
 * The ThreadPool will forward it to the extension logger.
 */
export function workerLog(level: WorkerLogMessage['level'], message: string): void {
    handler(level, message);
}
