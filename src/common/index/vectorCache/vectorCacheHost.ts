// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Vector Cache Host — child process entry point.
 *
 * This process is forked by VectorCacheClient and owns a LanceDB
 * database with a single cache table (sha256 → vector) plus an
 * in-memory bloom filter for fast miss rejection.
 *
 * All incoming batch messages are queued and executed serially to
 * guarantee ordering — a `getEmbeddings` request always sees the
 * results of any preceding `addEmbeddings`.
 *
 * Communication:
 *   VectorCacheClient ──IPC──► VectorCacheHost
 *   VectorCacheClient ◄──IPC── VectorCacheHost
 */

import { BloomFilter } from './bloomFilter';
import { VectorCacheDatabase } from './vectorCacheDatabase';
import type {
    VectorCacheInitRequest,
    VectorCacheShutdownRequest,
    VectorCacheBatchRequest,
    VectorCacheGetEmbeddingsRequest,
    VectorCacheAddEmbeddingsRequest,
} from '../types';

type ParentMessage = VectorCacheInitRequest | VectorCacheShutdownRequest | VectorCacheBatchRequest;

// ── State ─────────────────────────────────────────────────────────────

/** Bloom filter capacity — 4× headroom over Chromium-scale (~500K chunks). */
const BLOOM_FILTER_CAPACITY = 2_000_000;
const BLOOM_FILTER_FPR = 0.001; // 0.1% false positive rate

let db: VectorCacheDatabase | null = null;
let bloomFilter: BloomFilter | null = null;

/** Track additions since last compact to trigger periodic compaction. */
let additionsSinceCompact = 0;
const COMPACT_INTERVAL = 10_000;

// ── Serial message queue ──────────────────────────────────────────────

const messageQueue: VectorCacheBatchRequest[] = [];
let processing = false;

/**
 * Enqueue a batch message and start the serial processor.
 */
function enqueue(msg: VectorCacheBatchRequest): void {
    messageQueue.push(msg);
    processQueue();
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
            const msg = messageQueue.shift()!;
            try {
                if (msg.type === 'getEmbeddings') {
                    await handleGetEmbeddings(msg);
                } else if (msg.type === 'addEmbeddings') {
                    await handleAddEmbeddings(msg);
                }
            } catch (err) {
                sendLog('error', `[VectorCacheHost] Failed to process ${msg.type}: ${err}`);
                // Send an error response so the client's pending promise resolves
                if (msg.type === 'getEmbeddings') {
                    process.send?.({
                        type: 'getEmbeddings',
                        messageId: msg.messageId,
                        vectors: msg.sha256s.map(() => null),
                    });
                } else if (msg.type === 'addEmbeddings') {
                    process.send?.({
                        type: 'addEmbeddings',
                        messageId: msg.messageId,
                    });
                }
            }
        }
    } finally {
        processing = false;
    }
}

// ── Message handlers ──────────────────────────────────────────────────

async function handleGetEmbeddings(msg: VectorCacheGetEmbeddingsRequest): Promise<void> {
    const { messageId, sha256s } = msg;

    if (!db || !bloomFilter) {
        process.send?.({
            type: 'getEmbeddings',
            messageId,
            vectors: sha256s.map(() => null),
        });
        return;
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
        : new Map<string, Float32Array>();

    // Build response array: Float32Array for hits, null for misses.
    // Convert Float32Array to plain number[] for IPC transfer.
    const vectors: (number[] | null)[] = new Array(sha256s.length).fill(null);
    for (const idx of possibleHitIndices) {
        const vec = cachedMap.get(sha256s[idx]);
        if (vec) {
            vectors[idx] = Array.from(vec);
        }
    }

    process.send?.({
        type: 'getEmbeddings',
        messageId,
        vectors,
    });
}

async function handleAddEmbeddings(msg: VectorCacheAddEmbeddingsRequest): Promise<void> {
    const { messageId, sha256s, vectors } = msg;

    if (db && bloomFilter) {
        // Convert number[][] back to Float32Array[]
        const float32Vectors = vectors.map((v: number[]) => new Float32Array(v));
        await db.add(sha256s, float32Vectors);

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

    process.send?.({
        type: 'addEmbeddings',
        messageId,
    });
}

// ── Logging ───────────────────────────────────────────────────────────

function sendLog(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    process.send?.({ type: 'log', level, message });
}

// ── IPC from VectorCacheClient ────────────────────────────────────────

process.on('message', async (msg: ParentMessage) => {
    if (msg.type === 'init') {
        try {
            db = new VectorCacheDatabase(msg.dbPath, msg.vectorDimension);
            const sha256s = await db.open();

            bloomFilter = new BloomFilter(BLOOM_FILTER_CAPACITY, BLOOM_FILTER_FPR);
            for (const sha256 of sha256s) {
                bloomFilter.add(sha256);
            }

            sendLog('info', `[VectorCacheHost] Initialized: ${sha256s.length} cached entries, bloom filter populated`);
            process.send?.({ type: 'init-ack', entryCount: sha256s.length });
        } catch (err) {
            sendLog('error', `[VectorCacheHost] Init failed: ${err}`);
            process.send?.({ type: 'init-ack', entryCount: 0 });
        }
        return;
    }

    if (msg.type === 'shutdown') {
        try {
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

    // Batch requests — enqueue for serial processing
    if (msg.type === 'getEmbeddings' || msg.type === 'addEmbeddings') {
        enqueue(msg);
    }
});

// ── Global error handlers ─────────────────────────────────────────────

process.on('uncaughtException', (err) => {
    console.error('[VectorCacheHost] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('[VectorCacheHost] Unhandled rejection:', reason);
});
