// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * VectorCacheDatabase — a LanceDB wrapper for the vector cache.
 *
 * Stores `(sha256, vector)` pairs in a single table.  This database
 * lives in the vector cache child process and is entirely separate
 * from the main VectorDatabase used by the embedding pipeline.
 *
 * No foreign keys, no line numbers, no file paths — just content
 * hashes mapped to their embedding vectors.
 */

import * as fs from 'fs';
import type { Connection, Table } from '@lancedb/lancedb';

const TBL_VECTOR_CACHE = 'vector_cache';

export class VectorCacheDatabase {
    private readonly dbPath: string;
    private readonly vectorDimension: number;
    private db: Connection | null = null;
    private table: Table | null = null;

    /**
     * Create a VectorCacheDatabase instance.
     *
     * Call {@link open} before using any other methods.
     *
     * @param dbPath — directory where the LanceDB data files will be stored.
     * @param vectorDimension — the fixed length of every embedding vector.
     */
    constructor(dbPath: string, vectorDimension: number) {
        this.dbPath = dbPath;
        this.vectorDimension = vectorDimension;
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    /**
     * Open (or create) the database and the cache table.
     *
     * @returns The list of all sha256 values currently in the cache
     *          (for populating the bloom filter at startup).
     */
    async open(): Promise<string[]> {
        const lancedb = await import('@lancedb/lancedb');

        await fs.promises.mkdir(this.dbPath, { recursive: true });
        this.db = await lancedb.connect(this.dbPath);

        const tableNames = await this.db.tableNames();
        const sha256s: string[] = [];

        if (tableNames.includes(TBL_VECTOR_CACHE)) {
            this.table = await this.db.openTable(TBL_VECTOR_CACHE);

            // Scan sha256 column only (no vector data loaded) to
            // populate the bloom filter.
            const rows = await this.table
                .query()
                .select(['sha256'])
                .toArray() as { sha256: string }[];
            for (const row of rows) {
                sha256s.push(row.sha256);
            }

            // Compact on startup to keep the table fast
            await this.compact();
        }

        return sha256s;
    }

    /**
     * Close the database connection and release resources.
     */
    async close(): Promise<void> {
        this.table?.close();
        this.table = null;
        this.db?.close();
        this.db = null;
    }

    // ── Insert ──────────────────────────────────────────────────────────────

    /**
     * Add embedding vectors to the cache.
     *
     * @param sha256s — content hashes.
     * @param vectors — parallel array of base64-encoded f32 embedding strings.
     */
    async add(sha256s: string[], vectors: string[]): Promise<void> {
        if (sha256s.length === 0) {
            return;
        }

        this.ensureOpen();

        const rows = sha256s.map((sha256, i) => ({
            sha256,
            data: vectors[i],
        }));

        if (!this.table) {
            this.table = await this.db!.createTable(TBL_VECTOR_CACHE, rows);
            await this.createIndexSafe(this.table, 'sha256');
        } else {
            await this.table.add(rows);
        }
    }

    // ── Query ───────────────────────────────────────────────────────────────

    /**
     * Look up cached vectors for the given SHA-256 hashes.
     *
     * @param sha256s — the hashes to look up.
     * @returns A Map from sha256 → base64-encoded f32 string for all cache hits.
     *          Misses are simply absent from the map.
     */
    async get(sha256s: string[]): Promise<Map<string, string>> {
        const result = new Map<string, string>();

        if (sha256s.length === 0 || !this.table) {
            return result;
        }

        // Build an IN clause with quoted sha256 strings
        const quoted = sha256s.map(s => `'${s}'`).join(', ');
        const rows = await this.table
            .query()
            .select(['sha256', 'data'])
            .where(`sha256 IN (${quoted})`)
            .toArray() as { sha256: string; data: string }[];

        for (const row of rows) {
            result.set(row.sha256, row.data);
        }

        return result;
    }

    // ── Maintenance ─────────────────────────────────────────────────────────

    /**
     * Compact the cache table — merges small data files, physically
     * removes logically-deleted rows, prunes old table versions, and
     * updates scalar indices.
     *
     * Should be called periodically since the cache only ever grows.
     */
    async compact(): Promise<{ filesRemoved: number; bytesRemoved: number } | null> {
        if (!this.table) {
            return null;
        }
        try {
            const stats = await this.table.optimize();
            return {
                filesRemoved: stats.compaction.filesRemoved,
                bytesRemoved: stats.prune.bytesRemoved,
            };
        } catch {
            // Table may be empty or too small — safe to ignore
            return null;
        }
    }

    // ── Internals ───────────────────────────────────────────────────────────

    /**
     * Assert that the database connection is open.
     */
    private ensureOpen(): void {
        if (!this.db) {
            throw new Error('VectorCacheDatabase: database is not open — call open() first');
        }
    }

    /**
     * Create a scalar BTree index on a column, ignoring errors if the
     * index already exists or the table is empty.
     */
    private async createIndexSafe(table: Table, column: string): Promise<void> {
        try {
            await table.createIndex(column, { replace: false });
        } catch {
            // Index already exists or table is too small — safe to ignore
        }
    }
}
