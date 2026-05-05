// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * VectorCacheHttpServer — read-only HTTP API for remote cache queries.
 *
 * Exposes a single endpoint that allows remote developer machines to
 * query for cached embedding vectors over the network. This enables
 * GPU-less machines to check a teammate's cache before recomputing
 * embeddings from scratch.
 *
 * The server is read-only — remote clients can query for vectors but
 * not add them. Each machine populates its own local cache.
 *
 * Requests are funneled through a callback (`getEmbeddings`) which
 * the host wires to the serial message queue, ensuring consistent
 * ordering with IPC reads and writes.
 *
 * API:
 *   POST /api/v1/getEmbeddings
 *   Request:  { "sha256s": ["abc123...", "def456...", ...] }
 *   Response: { "vectors": ["<base64>", null, ...] }
 */

import * as http from 'http';
import type { Socket } from 'net';

/** Callback to look up cached vectors. Returns a parallel array of
 *  base64-encoded f32 strings (hits) or null (misses). */
type GetEmbeddingsFn = (sha256s: string[]) => Promise<(string | null)[]>;

/** Callback for forwarding log messages to the host's logging system. */
type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

/** Maximum request body size (1 MB). Prevents abuse from oversized payloads. */
const MAX_BODY_BYTES = 1_048_576;

/** Grace period (ms) before force-closing lingering connections during shutdown. */
const SHUTDOWN_TIMEOUT_MS = 3000;

export class VectorCacheHttpServer {
    private readonly host: string;
    private readonly port: number;
    private readonly getEmbeddings: GetEmbeddingsFn;
    private readonly log: LogFn;
    private server: http.Server | null = null;

    /** Open TCP connections — tracked for force-close during shutdown. */
    private readonly connections = new Set<Socket>();

    /**
     * Create a new VectorCacheHttpServer.
     *
     * Call {@link start} to begin accepting connections.
     *
     * @param host — bind address (e.g. '0.0.0.0' or '127.0.0.1').
     * @param port — TCP port to listen on.
     * @param getEmbeddings — callback to look up cached vectors.
     * @param log — callback for logging (forwarded to host's IPC logger).
     */
    constructor(host: string, port: number, getEmbeddings: GetEmbeddingsFn, log: LogFn) {
        this.host = host;
        this.port = port;
        this.getEmbeddings = getEmbeddings;
        this.log = log;
    }

    /**
     * Start the HTTP server and begin accepting connections.
     *
     * @returns A promise that resolves once the server is listening.
     */
    start(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.server = http.createServer((req, res) => this.handleRequest(req, res));

            // Track open connections for clean shutdown
            this.server.on('connection', (socket: Socket) => {
                this.connections.add(socket);
                socket.on('close', () => this.connections.delete(socket));
            });

            // Startup error handler (e.g. EADDRINUSE) — removed once listening
            const onStartupError = (err: NodeJS.ErrnoException) => {
                this.log('error', `[VectorCacheHttpServer] Failed to start: ${err.message}`);
                reject(err);
            };
            this.server.once('error', onStartupError);

            this.server.listen(this.port, this.host, () => {
                this.server!.removeListener('error', onStartupError);

                // Long-lived error handler for post-startup errors
                this.server!.on('error', (err: NodeJS.ErrnoException) => {
                    this.log('error', `[VectorCacheHttpServer] Server error: ${err.message}`);
                });

                this.log('info', `[VectorCacheHttpServer] Listening on http://${this.host}:${this.port}`);
                resolve();
            });
        });
    }

    /**
     * Gracefully stop the HTTP server.
     *
     * Stops accepting new connections and waits for in-flight
     * requests to complete. If connections remain open after
     * the grace period, they are force-closed.
     */
    stop(): Promise<void> {
        return new Promise<void>((resolve) => {
            if (!this.server) {
                resolve();
                return;
            }

            // Force-close lingering connections after the grace period
            const timeout = setTimeout(() => {
                if (this.connections.size > 0) {
                    this.log('warn', `[VectorCacheHttpServer] Force-closing ${this.connections.size} lingering connection(s)`);
                    for (const socket of this.connections) {
                        socket.destroy();
                    }
                    this.connections.clear();
                }
            }, SHUTDOWN_TIMEOUT_MS);

            this.server.close(() => {
                clearTimeout(timeout);
                this.log('info', '[VectorCacheHttpServer] Server stopped');
                this.server = null;
                resolve();
            });
        });
    }

    // ── Request handling ────────────────────────────────────────────────

    /**
     * Route incoming HTTP requests to the appropriate handler.
     */
    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        // Parse the URL to extract just the pathname, ignoring query
        // strings and path tricks from unknown clients.
        let pathname: string;
        try {
            pathname = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`).pathname;
        } catch {
            this.sendJson(res, 400, { error: 'Malformed URL' });
            return;
        }

        // Route: POST /api/v1/getEmbeddings
        if (req.method === 'POST' && pathname === '/api/v1/getEmbeddings') {
            this.handleGetEmbeddings(req, res);
            return;
        }

        // Route: GET /api/v1/health
        if (req.method === 'GET' && pathname === '/api/v1/health') {
            this.sendJson(res, 200, { status: 'ok' });
            return;
        }

        this.sendJson(res, 404, { error: 'Not found' });
    }

    /**
     * Handle POST /api/v1/getEmbeddings.
     *
     * Reads the JSON body, validates the sha256s array, looks up
     * vectors via the callback, and returns the results as a parallel
     * array of base64 strings (hits) or null (misses).
     */
    private handleGetEmbeddings(req: http.IncomingMessage, res: http.ServerResponse): void {
        // Reject requests with unexpected content types
        const contentType = req.headers['content-type'] ?? '';
        if (!contentType.startsWith('application/json')) {
            this.sendJson(res, 415, { error: 'Content-Type must be application/json' });
            return;
        }

        this.readBody(req, (err, body) => {
            if (err) {
                this.sendJson(res, 400, { error: err });
                return;
            }

            // Parse JSON
            let parsed: unknown;
            try {
                parsed = JSON.parse(body!);
            } catch {
                this.sendJson(res, 400, { error: 'Invalid JSON' });
                return;
            }

            // Validate structure
            if (!parsed || typeof parsed !== 'object') {
                this.sendJson(res, 400, { error: 'Request body must be a JSON object' });
                return;
            }

            const { sha256s } = parsed as { sha256s?: unknown };
            if (!Array.isArray(sha256s)) {
                this.sendJson(res, 400, { error: '"sha256s" must be an array' });
                return;
            }

            // Validate each element is a string
            for (let i = 0; i < sha256s.length; i++) {
                if (typeof sha256s[i] !== 'string') {
                    this.sendJson(res, 400, { error: `"sha256s[${i}]" must be a string` });
                    return;
                }
            }

            // Look up vectors
            this.getEmbeddings(sha256s)
                .then(vectors => {
                    this.sendJson(res, 200, { vectors });
                })
                .catch(lookupErr => {
                    this.log('error', `[VectorCacheHttpServer] getEmbeddings failed: ${lookupErr}`);
                    this.sendJson(res, 500, { error: 'Internal server error' });
                });
        });
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    /**
     * Read the request body as a UTF-8 string with size limit enforcement.
     */
    private readBody(req: http.IncomingMessage, callback: (err: string | null, body: string | null) => void): void {
        const chunks: Buffer[] = [];
        let totalBytes = 0;

        req.on('data', (chunk: Buffer) => {
            totalBytes += chunk.length;
            if (totalBytes > MAX_BODY_BYTES) {
                req.destroy();
                callback(`Request body exceeds ${MAX_BODY_BYTES} bytes`, null);
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => {
            callback(null, Buffer.concat(chunks).toString('utf8'));
        });

        req.on('error', (err) => {
            callback(`Error reading request body: ${err.message}`, null);
        });
    }

    /**
     * Send a JSON response with the given status code and body.
     */
    private sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
        const json = JSON.stringify(body);
        res.writeHead(statusCode, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(json),
            'Connection': 'close',
            'X-Content-Type-Options': 'nosniff',
        });
        res.end(json);
    }
}
