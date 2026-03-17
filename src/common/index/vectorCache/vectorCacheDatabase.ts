// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * VectorCacheDatabase — a SQLite-backed key-value cache for embeddings.
 *
 * Stores `(sha256, data)` pairs in a single table where `data` is a
 * base64-encoded f32 embedding string. This database lives in the
 * vector cache child process and is entirely separate from the main
 * VectorDatabase used by the embedding pipeline.
 *
 * Uses Node's built-in `node:sqlite` module (available since v22.5)
 * with WAL mode for fast concurrent reads and writes. Prepared
 * statements with parameter binding are used for all queries to
 * avoid SQL parsing overhead on every call.
 *
 * No foreign keys, no line numbers, no file paths — just content
 * hashes mapped to their embedding vectors.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

export class VectorCacheDatabase {
    private readonly dbPath: string;
    private readonly vectorDimension: number;
    private db: DatabaseSync | null = null;

    // Prepared statements — pre-compiled SQL templates that are created
    // once and reused for every call. SQLite parses and compiles the SQL
    // into an optimized query plan on the first prepare() call, then
    // subsequent executions just bind new parameter values (the ? placeholders)
    // and run the pre-compiled plan. This avoids re-parsing the SQL string
    // on every query, which is the dominant cost for simple lookups.
    private stmtGet: ReturnType<DatabaseSync['prepare']> | null = null;
    private stmtInsert: ReturnType<DatabaseSync['prepare']> | null = null;
    private stmtSelectAllSha256s: ReturnType<DatabaseSync['prepare']> | null = null;

    /**
     * Create a VectorCacheDatabase instance.
     *
     * Call {@link open} before using any other methods.
     *
     * @param dbPath — directory where the SQLite database file will be stored.
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
        await fs.promises.mkdir(this.dbPath, { recursive: true });

        const dbFilePath = path.join(this.dbPath, 'vector_cache.db');
        this.db = new DatabaseSync(dbFilePath);

        // Enable WAL mode for fast concurrent reads/writes.
        // WAL keeps data on disk but uses memory-mapped I/O for reads,
        // so hot data stays in the OS page cache automatically.
        // Fully crash-safe: committed transactions are fsync'd to disk
        // before COMMIT returns; after a crash, SQLite replays the WAL
        // and discards any uncommitted partial writes.
        this.db.exec('PRAGMA journal_mode = WAL');

        // Set page cache to ~50MB (12500 pages × 4KB) — enough to keep
        // the BTree index resident for fast lookups while capping memory.
        // At 500K entries the index is ~36MB; at 20M entries ~2.4GB, so
        // 50MB keeps the upper BTree levels cached for fast traversal.
        this.db.exec('PRAGMA cache_size = 12500');

        // Create the cache table if it doesn't exist
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS vector_cache (
                sha256 TEXT PRIMARY KEY NOT NULL,
                data TEXT NOT NULL
            )
        `);

        // Prepare reusable statements
        this.stmtGet = this.db.prepare('SELECT data FROM vector_cache WHERE sha256 = ?');
        this.stmtInsert = this.db.prepare('INSERT OR REPLACE INTO vector_cache (sha256, data) VALUES (?, ?)');
        this.stmtSelectAllSha256s = this.db.prepare('SELECT sha256 FROM vector_cache');

        // Scan sha256 column to populate the bloom filter
        const sha256s: string[] = [];
        const rows = this.stmtSelectAllSha256s.all() as { sha256: string }[];
        for (const row of rows) {
            sha256s.push(row.sha256);
        }

        return sha256s;
    }

    /**
     * Close the database connection and release resources.
     */
    async close(): Promise<void> {
        this.stmtGet = null;
        this.stmtInsert = null;
        this.stmtSelectAllSha256s = null;
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

        // Wrap all inserts in a single transaction for performance.
        // Without this, each INSERT is an implicit transaction with
        // its own fsync — ~100x slower.
        this.db!.exec('BEGIN');
        try {
            for (let i = 0; i < sha256s.length; i++) {
                this.stmtInsert!.run(sha256s[i], vectors[i]);
            }
            this.db!.exec('COMMIT');
        } catch (err) {
            this.db!.exec('ROLLBACK');
            throw err;
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

        if (sha256s.length === 0 || !this.stmtGet) {
            return result;
        }

        // Wrap reads in a single transaction to avoid per-call implicit
        // transaction overhead in WAL mode.
        this.db!.exec('BEGIN');
        try {
            for (const sha256 of sha256s) {
                const row = this.stmtGet.get(sha256) as { data: string } | undefined;
                if (row) {
                    result.set(sha256, row.data);
                }
            }
            this.db!.exec('COMMIT');
        } catch (err) {
            this.db!.exec('ROLLBACK');
            throw err;
        }

        return result;
    }

    // ── Maintenance ─────────────────────────────────────────────────────────

    /**
     * Compact the database — in SQLite this runs VACUUM to reclaim
     * disk space from deleted rows and defragment the database file.
     *
     * Note: VACUUM rewrites the entire database file and can be slow
     * for large databases. For the vector cache (append-only, no deletes),
     * this is rarely needed.
     */
    async compact(): Promise<{ filesRemoved: number; bytesRemoved: number } | null> {
        if (!this.db) {
            return null;
        }
        try {
            // WAL checkpoint — merge WAL back into main database
            this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            return { filesRemoved: 0, bytesRemoved: 0 };
        } catch {
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
}
