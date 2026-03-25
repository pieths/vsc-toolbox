// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Vector Cache Host — child process entry point.
 *
 * This process is forked by VectorCacheClient and owns a SQLite
 * database with a single cache table (sha256 → vector) plus an
 * in-memory bloom filter for fast miss rejection.
 *
 * All incoming messages (IPC and HTTP) are queued and executed serially
 * to guarantee ordering — a `getEmbeddings` request always sees the
 * results of any preceding `addEmbeddings`.
 *
 * Communication:
 *   VectorCacheClient ──IPC──► VectorCacheHost
 *   VectorCacheClient ◄──IPC── VectorCacheHost
 *   Remote clients ───HTTP──► VectorCacheHost (read-only, optional)
 */

import { BloomFilter } from './bloomFilter';
import { VectorCacheDatabase } from './vectorCacheDatabase';
import { VectorCacheHttpServer } from './vectorCacheHttpServer';
import type {
    VectorCacheInitRequest,
    VectorCacheShutdownRequest,
    VectorCacheBatchRequest,
    VectorCacheBatchResponse,
    VectorCacheGetEmbeddingsRequest,
    VectorCacheGetEmbeddingsResponse,
    VectorCacheAddEmbeddingsRequest,
    VectorCacheAddEmbeddingsResponse,
} from '../types';

type ParentMessage = VectorCacheInitRequest | VectorCacheShutdownRequest | VectorCacheBatchRequest;

// ── State ─────────────────────────────────────────────────────────────

/** Bloom filter capacity — ~17 MB at 0.1% FPR, sized for large-scale shared caches. */
const BLOOM_FILTER_CAPACITY = 10_000_000;
const BLOOM_FILTER_FPR = 0.001; // 0.1% false positive rate

let db: VectorCacheDatabase | null = null;
let bloomFilter: BloomFilter | null = null;
let httpServer: VectorCacheHttpServer | null = null;

/** Track additions since last compact to trigger periodic compaction. */
let additionsSinceCompact = 0;
const COMPACT_INTERVAL = 10_000;

// ── Core lookup logic ─────────────────────────────────────────────────

/**
 * Look up cached vectors for the given SHA-256 hashes.
 *
 * Uses the bloom filter for fast miss rejection, then queries the
 * database only for possible hits. Returns a parallel array of
 * base64-encoded f32 strings (hits) or null (misses).
 *
 * This function is used by both IPC and HTTP request handlers.
 */
async function lookupEmbeddings(sha256s: string[]): Promise<(string | null)[]> {
    if (!db || !bloomFilter) {
        return sha256s.map(() => null);
    }

    // Use bloom filter to partition into definite misses and possible hits
    const possibleHits: string[] = [];
    const possibleHitIndices: number[] = [];
    for (let i = 0; i < sha256s.length; i++) {
        if (bloomFilter.mightContain(sha256s[i])) {
            possibleHits.push(sha256s[i]);
            possibleHitIndices.push(i);
        }
    }

    // Query DB only for possible hits
    const cachedMap = possibleHits.length > 0
        ? await db.get(possibleHits)
        : new Map<string, string>();

    // Build response array: base64 string for hits, null for misses.
    const vectors: (string | null)[] = new Array(sha256s.length).fill(null);
    for (const idx of possibleHitIndices) {
        const vec = cachedMap.get(sha256s[idx]);
        if (vec) {
            vectors[idx] = vec;
        }
    }

    return vectors;
}

/**
 * Add embedding vectors to the cache and update the bloom filter.
 *
 * Wraps the database insert in a single transaction, updates the
 * bloom filter for fast miss rejection, and triggers periodic
 * compaction to keep the database fast.
 *
 * This function is used by the serial queue's addEmbeddings handler.
 */
async function addEmbeddings(sha256s: string[], vectors: string[]): Promise<void> {
    if (db && bloomFilter) {
        await db.add(sha256s, vectors);

        // Update bloom filter
        for (const sha256 of sha256s) {
            bloomFilter.add(sha256);
        }

        // Periodic compaction to keep the table fast
        additionsSinceCompact += sha256s.length;
        if (additionsSinceCompact >= COMPACT_INTERVAL) {
            additionsSinceCompact = 0;
            const stats = await db.compact();
            if (stats) {
                sendLog('info', `[VectorCacheHost] Compacted cache table — removed ${stats.filesRemoved} files, ${stats.bytesRemoved} bytes`);
            }
        }
    }
}

// ── Serial message queue ──────────────────────────────────────────────

/**
 * A queued message paired with a callback for delivering the response.
 * IPC messages respond via process.send(); HTTP messages respond via
 * a promise resolver wired to the HTTP response.
 */
interface QueueEntry {
    msg: VectorCacheBatchRequest;
    respond: (response: any) => void;
}

const messageQueue: QueueEntry[] = [];
let processing = false;

/**
 * Enqueue a message with its response callback and start the serial processor.
 */
function enqueue(entry: QueueEntry): void {
    messageQueue.push(entry);
    processQueue();
}

/**
 * Enqueue a getEmbeddings request from the HTTP server.
 *
 * Returns a promise that resolves with the lookup results once the
 * serial queue processes the request. This is the callback wired
 * into VectorCacheHttpServer.
 */
function enqueueHttpGetEmbeddings(sha256s: string[]): Promise<(string | null)[]> {
    return new Promise<(string | null)[]>((resolve) => {
        const msg: VectorCacheGetEmbeddingsRequest = {
            type: 'getEmbeddings',
            messageId: -1, // Not used for HTTP — response goes via the promise
            sha256s,
        };
        enqueue({
            msg,
            respond: (response: VectorCacheGetEmbeddingsResponse) => {
                resolve(response.vectors);
            },
        });
    });
}

/**
 * Process queued messages one at a time.
 * Re-entrant safe — if already processing, the current run will
 * pick up newly enqueued messages via the while loop.
 */
async function processQueue(): Promise<void> {
    if (processing) {
        return;
    }
    processing = true;

    try {
        while (messageQueue.length > 0) {
            const { msg, respond } = messageQueue.shift()!;
            try {
                if (msg.type === 'getEmbeddings') {
                    const vectors = await lookupEmbeddings(msg.sha256s);
                    const response: VectorCacheGetEmbeddingsResponse = {
                        type: 'getEmbeddings',
                        messageId: msg.messageId,
                        vectors,
                    };
                    respond(response);
                } else if (msg.type === 'addEmbeddings') {
                    await addEmbeddings(msg.sha256s, msg.vectors);
                    const response: VectorCacheAddEmbeddingsResponse = {
                        type: 'addEmbeddings',
                        messageId: msg.messageId,
                    };
                    respond(response);
                }
            } catch (err) {
                sendLog('error', `[VectorCacheHost] Failed to process ${msg.type}: ${err}`);
                // Send an error response so the caller's pending promise resolves
                if (msg.type === 'getEmbeddings') {
                    const response: VectorCacheGetEmbeddingsResponse = {
                        type: 'getEmbeddings',
                        messageId: msg.messageId,
                        vectors: msg.sha256s.map(() => null),
                    };
                    respond(response);
                } else if (msg.type === 'addEmbeddings') {
                    const response: VectorCacheAddEmbeddingsResponse = {
                        type: 'addEmbeddings',
                        messageId: msg.messageId,
                    };
                    respond(response);
                }
            }
        }
    } finally {
        processing = false;
    }
}

// ── Logging ───────────────────────────────────────────────────────────

function sendLog(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    process.send?.({ type: 'log', level, message });
}

// ── IPC response helper ──────────────────────────────────────────────

/** Send a response back to the parent process via IPC. */
function respondViaIpc(response: VectorCacheBatchResponse): void {
    process.send?.(response);
}

// ── IPC handlers ─────────────────────────────────────────────────────

/**
 * Handle the 'init' message from VectorCacheClient.
 *
 * Opens the database, populates the bloom filter, optionally starts
 * the HTTP server, and sends back an init-ack with the entry count.
 */
async function handleInit(msg: VectorCacheInitRequest): Promise<void> {
    try {
        db = new VectorCacheDatabase(msg.dbPath, msg.vectorDimension);
        const sha256s = await db.open();

        bloomFilter = new BloomFilter(BLOOM_FILTER_CAPACITY, BLOOM_FILTER_FPR);
        for (const sha256 of sha256s) {
            bloomFilter.add(sha256);
        }

        sendLog('info', [
            `[VectorCacheHost] Initialized:`,
            `  Cached entries  : ${sha256s.length}`,
            `  Bloom capacity  : ${BLOOM_FILTER_CAPACITY.toLocaleString()}`,
            `  Bloom memory    : ${(bloomFilter.getNumBytes() / 1024 / 1024).toFixed(1)} MB`,
            `  Hash functions  : ${bloomFilter.getNumHashFunctions()}`,
        ].join('\n'));

        // Start HTTP server if configured
        if (msg.httpPort !== undefined) {
            const host = msg.httpHost ?? '0.0.0.0';
            httpServer = new VectorCacheHttpServer(host, msg.httpPort, enqueueHttpGetEmbeddings, sendLog);
            try {
                await httpServer.start();
            } catch (err) {
                sendLog('error', `[VectorCacheHost] Failed to start HTTP server: ${err}`);
                httpServer = null;
            }
        }

        process.send?.({ type: 'init-ack', entryCount: sha256s.length });
    } catch (err) {
        sendLog('error', `[VectorCacheHost] Init failed: ${err}`);
        process.send?.({ type: 'init-ack', entryCount: 0 });
    }
}

/**
 * Handle the 'shutdown' message from VectorCacheClient.
 *
 * Stops the HTTP server, drains the serial queue, closes the
 * database, and exits the process.
 */
async function handleShutdown(): Promise<void> {
    try {
        // Stop HTTP server first (stop accepting new requests)
        if (httpServer) {
            await httpServer.stop();
            httpServer = null;
        }

        // Drain any in-flight messages before shutting down
        while (messageQueue.length > 0 || processing) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        await db?.close();
    } catch (err) {
        console.error('[VectorCacheHost] Error during shutdown:', err);
    }
    process.exit(0);
}

// ── IPC from VectorCacheClient ────────────────────────────────────────

process.on('message', async (msg: ParentMessage) => {
    if (msg.type === 'init') {
        await handleInit(msg);
        return;
    }

    if (msg.type === 'shutdown') {
        await handleShutdown();
        return;
    }

    // Batch requests — enqueue for serial processing with IPC response
    if (msg.type === 'getEmbeddings' || msg.type === 'addEmbeddings') {
        enqueue({ msg, respond: respondViaIpc });
    }
});

// ── Global error handlers ─────────────────────────────────────────────

process.on('uncaughtException', (err) => {
    console.error('[VectorCacheHost] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('[VectorCacheHost] Unhandled rejection:', reason);
});
