// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * VectorCacheClient — extension-side proxy for the vector cache child process.
 *
 * Spawns a child process running `vectorCacheHost.ts` and provides a
 * typed async API for looking up and storing cached embedding vectors.
 *
 * Follows the same fork + IPC pattern as ThreadPool ↔ WorkerHost.
 */

import { fork, ChildProcess } from 'child_process';
import * as path from 'path';
import type {
    VectorCacheBatchResponse,
    VectorCacheLogMessage,
    VectorCacheInitAckResponse,
    VectorCacheGetEmbeddingsResponse,
    VectorCacheAddEmbeddingsResponse,
} from '../types';
import { debug, log, warn, error } from '../../logger';

/** Maximum time (ms) to wait for the child process to send init-ack */
const INIT_TIMEOUT_MS = 30000;

type ChildMessage =
    | VectorCacheInitAckResponse
    | VectorCacheLogMessage
    | VectorCacheBatchResponse;

export class VectorCacheClient {
    private childProcess: ChildProcess | null = null;
    private nextMessageId: number = 0;
    private pendingRequests: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }> = new Map();
    private disposed: boolean = false;
    private initPromise: Promise<void>;
    private readonly nodePath: string;
    private readonly dbPath: string;
    private readonly vectorDimension: number;
    private readonly httpPort?: number;
    private readonly httpHost?: string;

    /**
     * Create a new VectorCacheClient.
     * Forks a child process (VectorCacheHost) that owns the cache database.
     *
     * @param nodePath — absolute path to standalone Node.js binary (avoids Electron's memory limits)
     * @param dbPath — absolute path to the cache database directory
     * @param vectorDimension — dimension of the embedding vectors
     * @param httpPort — optional TCP port for the HTTP cache server (omit to disable)
     * @param httpHost — optional bind address for the HTTP cache server (default: '0.0.0.0')
     */
    constructor(nodePath: string, dbPath: string, vectorDimension: number, httpPort?: number, httpHost?: string) {
        this.nodePath = nodePath;
        this.dbPath = dbPath;
        this.vectorDimension = vectorDimension;
        this.httpPort = httpPort;
        this.httpHost = httpHost;
        this.initPromise = this.spawnChild();
    }

    /**
     * Fork the VectorCacheHost child process and wait for init-ack.
     */
    private spawnChild(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const hostPath = path.join(__dirname, 'vectorCacheHost.js');

            // fork() defaults to process.execPath which, inside VS Code's
            // extension host, points to Electron (Code.exe). Electron caps
            // memory at relatively conservative values. Using a standalone
            // Node.js binary removes that limit, allowing the child process
            // to allocate more memory if needed.
            this.childProcess = fork(hostPath, [], {
                execPath: this.nodePath,
                stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
                windowsHide: true,
            } as any);

            const initTimeout = setTimeout(() => {
                error(`[VectorCacheClient] Child process did not acknowledge init within ${INIT_TIMEOUT_MS}ms. Killing...`);
                try {
                    this.childProcess?.kill();
                } catch {
                    // Already dead
                }
                reject(new Error(`Vector cache host init timed out after ${INIT_TIMEOUT_MS}ms`));
            }, INIT_TIMEOUT_MS);

            const onInitAck = (msg: ChildMessage) => {
                if (msg.type === 'init-ack') {
                    clearTimeout(initTimeout);
                    this.childProcess!.removeListener('message', onInitAck);
                    log(`[VectorCacheClient] Cache host started with ${msg.entryCount} cached entries`);
                    resolve();
                }
            };

            this.childProcess.on('message', onInitAck);

            this.childProcess.on('message', (msg: ChildMessage) => {
                // Handle init-ack (already handled above for first time)
                if (msg.type === 'init-ack') {
                    return;
                }

                // Handle log messages forwarded from the cache host
                if (msg.type === 'log') {
                    const text = `[VectorCache] ${msg.message}`;
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
                    pending.resolve(msg);
                }
            });

            this.childProcess.on('error', (err: Error) => {
                clearTimeout(initTimeout);
                error(`[VectorCacheClient] Child process error: ${err.message}`);
                reject(err);
            });

            this.childProcess.on('exit', (code: number | null, signal: string | null) => {
                if (!this.disposed) {
                    warn(`[VectorCacheClient] Child process exited unexpectedly (code=${code}, signal=${signal}). Restarting...`);

                    // Reject all in-flight requests
                    for (const [, pending] of this.pendingRequests) {
                        pending.reject(new Error(`Vector cache host process exited (code=${code})`));
                    }
                    this.pendingRequests.clear();

                    // Restart the child process
                    this.childProcess = null;
                    this.initPromise = this.spawnChild();
                }
            });

            // Send init message with database configuration
            this.childProcess.send({
                type: 'init',
                dbPath: this.dbPath,
                vectorDimension: this.vectorDimension,
                httpPort: this.httpPort,
                httpHost: this.httpHost,
            });
        });
    }

    /**
     * Send a batch request to the child process and return a promise
     * for the response.
     */
    private sendRequest(request: any): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.childProcess?.connected) {
                reject(new Error('Vector cache child process not connected'));
                return;
            }

            this.pendingRequests.set(request.messageId, { resolve, reject });
            this.childProcess.send(request);
        });
    }

    /**
     * Look up cached vectors for the given SHA-256 hashes.
     *
     * Returns an array of the same length as the input. Each element is
     * either a base64-encoded f32 string (cache hit) or null (cache miss).
     */
    async getEmbeddings(sha256s: string[]): Promise<(string | null)[]> {
        if (this.disposed || sha256s.length === 0) {
            return sha256s.map(() => null);
        }

        await this.initPromise;

        const messageId = this.nextMessageId++;
        try {
            const response: VectorCacheGetEmbeddingsResponse = await this.sendRequest({
                type: 'getEmbeddings',
                messageId,
                sha256s,
            });

            return response.vectors;
        } catch (err) {
            warn(`[VectorCacheClient] getEmbeddings failed: ${err}`);
            return sha256s.map(() => null);
        }
    }

    /**
     * Store newly-computed vectors in the cache.
     *
     * sha256s and vectors must be parallel arrays of the same length.
     *
     * Returns a Promise that resolves when the child process confirms
     * the insertion. The caller may choose not to await it (fire-and-
     * forget). Internally, VectorCacheClient attaches a .catch() to
     * every returned promise so that errors are always logged,
     * regardless of whether the caller awaits.
     */
    addEmbeddings(sha256s: string[], vectors: string[]): Promise<void> {
        if (this.disposed || sha256s.length === 0) {
            return Promise.resolve();
        }

        const doAdd = async (): Promise<void> => {
            await this.initPromise;

            const messageId = this.nextMessageId++;

            await this.sendRequest({
                type: 'addEmbeddings',
                messageId,
                sha256s,
                vectors,
            });
        };

        const promise = doAdd();

        // Attach internal .catch() so errors are always logged,
        // even if the caller does not await.
        promise.catch(err => {
            warn(`[VectorCacheClient] addEmbeddings failed: ${err}`);
        });

        return promise;
    }

    /**
     * Check if the client has been disposed.
     */
    isDisposed(): boolean {
        return this.disposed;
    }

    /**
     * Gracefully shut down the child process.
     * Sends a shutdown message and waits for the process to exit.
     */
    async dispose(): Promise<void> {
        if (this.disposed) {
            return;
        }

        this.disposed = true;

        // Reject all in-flight requests
        for (const [, pending] of this.pendingRequests) {
            pending.reject(new Error('VectorCacheClient disposed'));
        }
        this.pendingRequests.clear();

        if (!this.childProcess) {
            return;
        }

        const proc = this.childProcess;
        this.childProcess = null;

        // If the process already exited, nothing to wait for
        if (proc.exitCode !== null || proc.signalCode !== null) {
            log('[VectorCacheClient] Child process already exited');
            return;
        }

        // Wait for the child process to exit. Register the exit listener
        // BEFORE sending shutdown to avoid a race where the exit event
        // fires before our listener is registered.
        log(`[VectorCacheClient] Waiting for child process to exit (pid=${proc.pid})`);
        const exitPromise = new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                warn('[VectorCacheClient] Child process did not exit within 10 seconds, force-killing...');
                try { proc.disconnect(); } catch { /* already disconnected */ }
                try { proc.kill(); } catch { /* already dead */ }
                resolve();
            }, 10000);

            proc.on('exit', (code, signal) => {
                log(`[VectorCacheClient] Child exited (code=${code}, signal=${signal})`);
                clearTimeout(timeout);
                // IPC channel is automatically closed when the child exits.
                resolve();
            });
        });

        // Send graceful shutdown message. Don't disconnect IPC yet —
        // the child needs the channel open to receive the message and
        // do its cleanup. It calls process.exit(0) when done.
        if (proc.connected) {
            try {
                proc.send({ type: 'shutdown' });
            } catch {
                // Ignore send errors during shutdown
            }
        } else {
            try { proc.kill(); } catch { /* already dead */ }
        }

        await exitPromise;

        log('[VectorCacheClient] Child process stopped');
    }
}
