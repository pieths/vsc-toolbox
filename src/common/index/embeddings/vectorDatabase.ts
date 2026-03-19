// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * VectorDatabase — dual-storage database for file chunk metadata and embeddings.
 *
 * Storage:
 *
 *   SQLite (metadata.db, WAL mode):
 *     file_paths  — id (AUTOINCREMENT), filePath, sha256
 *     file_chunks — id (AUTOINCREMENT), filePathId, startLine, endLine, sha256, vectorId
 *
 *   LanceDB (vectors/ subdirectory):
 *     vectors     — id, vector (float32[], fixed dimension), fileChunkId
 *
 * SQLite handles all scalar metadata operations (inserts, deletes, lookups,
 * updates) using prepared statements and transactions for maximum throughput.
 * LanceDB handles only vector storage and nearest-neighbor search.
 *
 * Vectors and FileChunks have a 1:1 relationship via their mutual
 * foreign keys (vectorId ↔ fileChunkId). FilePaths stores both the
 * file path string and the source-file SHA-256 hash that the chunks
 * were generated from.
 *
 * SQLite's AUTOINCREMENT handles id generation for file_paths and file_chunks,
 * eliminating the need for manual id counters and the meta.json persistence
 * file. Only the LanceDB vectors table still requires a manual id counter
 * (recovered from a table scan on startup).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Connection, Table } from '@lancedb/lancedb';
import { DatabaseSync } from 'node:sqlite';
import { log, warn, error } from '../../logger';

// ── Public types ────────────────────────────────────────────────────────────

/** A FileChunk record as stored in the database (filePathId FK resolved). */
export interface FileChunkRecord {
    /** Unique FileChunk identifier */
    id: number;
    /** Resolved file path string */
    filePath: string;
    /** Foreign key into the FilePaths table */
    filePathId: number;
    /** 1-based start line in the file */
    startLine: number;
    /** 1-based end line in the file */
    endLine: number;
    /** SHA-256 hash of the chunk text (hex string) */
    sha256: string;
    /** Foreign key into the Vectors table */
    vectorId: number;
}

/** Input data for inserting a FileChunk (includes the embedding vector). */
export interface FileChunkInput {
    /** Path to the source file */
    filePath: string;
    /** 1-based start line in the file */
    startLine: number;
    /** 1-based end line in the file */
    endLine: number;
    /** SHA-256 hash of the chunk text (hex string) */
    sha256: string;
    /** Embedding vector */
    vector: Float32Array;
}

/** A FileChunk result returned from a nearest-neighbor search. */
export interface FileChunkSearchResult {
    /** Unique FileChunk identifier */
    id: number;
    /** Resolved file path string */
    filePath: string;
    /** 1-based start line in the file */
    startLine: number;
    /** 1-based end line in the file */
    endLine: number;
    /** SHA-256 hash of the chunk text (hex string) */
    sha256: string;
    /** Cosine distance from the query vector (0 = identical, 1 = orthogonal, 2 = opposite) */
    _distance: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** LanceDB table name for vectors. */
const TBL_VECTORS = 'vectors';

/** SQLite database filename within dbPath. */
const SQLITE_DB_FILE = 'metadata.db';

/** LanceDB subdirectory within dbPath (vectors stored separately). */
const LANCEDB_DIR = 'vectors';

// ── Class ───────────────────────────────────────────────────────────────────

export class VectorDatabase {
    private readonly dbPath: string;
    private readonly vectorDimension: number;

    // ── SQLite (file_paths + file_chunks metadata) ──────────────────────
    private sqliteDb: DatabaseSync | null = null;

    // Prepared statements — pre-compiled SQL templates created once in
    // open() and reused for every call. SQLite compiles the SQL into an
    // optimized query plan on prepare(), then subsequent executions just
    // bind new parameter values and run the pre-compiled plan.
    // Same loop-in-transaction pattern as VectorCacheDatabase.
    private stmtInsertFilePath: ReturnType<DatabaseSync['prepare']> | null = null;
    private stmtDeleteFilePath: ReturnType<DatabaseSync['prepare']> | null = null;
    private stmtUpdateFileVersion: ReturnType<DatabaseSync['prepare']> | null = null;
    private stmtInsertFileChunk: ReturnType<DatabaseSync['prepare']> | null = null;
    private stmtDeleteFileChunkById: ReturnType<DatabaseSync['prepare']> | null = null;
    private stmtDeleteChunksByFilePathId: ReturnType<DatabaseSync['prepare']> | null = null;
    private stmtGetChunksByFilePathId: ReturnType<DatabaseSync['prepare']> | null = null;
    private stmtGetChunkById: ReturnType<DatabaseSync['prepare']> | null = null;
    private stmtUpdateChunkLines: ReturnType<DatabaseSync['prepare']> | null = null;
    private stmtCountFileChunks: ReturnType<DatabaseSync['prepare']> | null = null;

    // ── LanceDB (vectors only) ──────────────────────────────────────────
    private lanceDb: Connection | null = null;
    private vectorsTable: Table | null = null;

    /**
     * Counter for LanceDB vector IDs.  SQLite tables use AUTOINCREMENT
     * but LanceDB has no built-in auto-increment, so we maintain this
     * manually and recover it from a table scan on startup.
     */
    private nextVectorId: number = 1;

    /** In-memory cache: filePath → filePathId (forward lookup). */
    private filePathCache = new Map<string, number>();

    /** In-memory cache: filePathId → filePath (reverse lookup). */
    private filePathIdToPath = new Map<number, string>();

    /** In-memory cache: filePathId → sha256 (file version lookup). */
    private fileVersionCache = new Map<number, string>();

    /**
     * Create a VectorDatabase instance.
     *
     * Call {@link open} before using any other methods.
     *
     * @param dbPath — directory where database files will be stored.
     *                 SQLite at `dbPath/metadata.db`, LanceDB at `dbPath/vectors/`.
     * @param vectorDimension — the fixed length of every embedding vector.
     */
    constructor(dbPath: string, vectorDimension: number) {
        this.dbPath = dbPath;
        this.vectorDimension = vectorDimension;
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    /**
     * Open (or create) the database and all tables.
     *
     * Creates the SQLite database with WAL mode and prepared statements,
     * opens the LanceDB connection for vectors, and populates in-memory
     * caches from the SQLite file_paths table.
     */
    async open(): Promise<void> {
        await fs.promises.mkdir(this.dbPath, { recursive: true });

        // ── SQLite setup ────────────────────────────────────────────────

        const dbFilePath = path.join(this.dbPath, SQLITE_DB_FILE);
        this.sqliteDb = new DatabaseSync(dbFilePath);

        // WAL mode for fast concurrent reads/writes. Fully crash-safe:
        // committed transactions are fsync'd to disk before COMMIT returns.
        this.sqliteDb.exec('PRAGMA journal_mode = WAL');

        // 50MB page cache (12500 pages × 4KB) — enough to keep BTree
        // indexes resident in memory for fast lookups after warmup.
        this.sqliteDb.exec('PRAGMA cache_size = 12500');

        // Raise auto-checkpoint threshold to ~15 MB (3840 pages × 4KB)
        // so bulk inserts don't trigger frequent expensive checkpoints.
        // Manual checkpoints are done in compact() during idle periods.
        this.sqliteDb.exec('PRAGMA wal_autocheckpoint = 3840');

        // Create tables (AUTOINCREMENT provides monotonically increasing
        // IDs that are never reused, even after deletes)
        this.sqliteDb.exec(`
            CREATE TABLE IF NOT EXISTS file_paths (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filePath TEXT NOT NULL UNIQUE,
                sha256 TEXT NOT NULL DEFAULT ''
            )
        `);

        this.sqliteDb.exec(`
            CREATE TABLE IF NOT EXISTS file_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filePathId INTEGER NOT NULL,
                startLine INTEGER NOT NULL,
                endLine INTEGER NOT NULL,
                sha256 TEXT NOT NULL,
                vectorId INTEGER NOT NULL,
                FOREIGN KEY (filePathId) REFERENCES file_paths(id)
            )
        `);
        this.sqliteDb.exec(
            'CREATE INDEX IF NOT EXISTS idx_file_chunks_filePathId ON file_chunks(filePathId)'
        );

        // ── Prepare reusable statements ─────────────────────────────────

        this.stmtInsertFilePath = this.sqliteDb.prepare(
            'INSERT INTO file_paths (filePath, sha256) VALUES (?, ?)'
        );
        this.stmtDeleteFilePath = this.sqliteDb.prepare(
            'DELETE FROM file_paths WHERE id = ?'
        );
        this.stmtUpdateFileVersion = this.sqliteDb.prepare(
            'UPDATE file_paths SET sha256 = ? WHERE id = ?'
        );
        this.stmtInsertFileChunk = this.sqliteDb.prepare(
            'INSERT INTO file_chunks (filePathId, startLine, endLine, sha256, vectorId) VALUES (?, ?, ?, ?, ?)'
        );
        this.stmtDeleteFileChunkById = this.sqliteDb.prepare(
            'DELETE FROM file_chunks WHERE id = ? RETURNING vectorId'
        );
        this.stmtDeleteChunksByFilePathId = this.sqliteDb.prepare(
            'DELETE FROM file_chunks WHERE filePathId = ? RETURNING vectorId'
        );
        this.stmtGetChunksByFilePathId = this.sqliteDb.prepare(
            'SELECT id, filePathId, startLine, endLine, sha256, vectorId FROM file_chunks WHERE filePathId = ?'
        );
        this.stmtGetChunkById = this.sqliteDb.prepare(
            'SELECT id, filePathId, startLine, endLine, sha256 FROM file_chunks WHERE id = ?'
        );
        this.stmtUpdateChunkLines = this.sqliteDb.prepare(
            'UPDATE file_chunks SET startLine = ?, endLine = ? WHERE id = ?'
        );
        this.stmtCountFileChunks = this.sqliteDb.prepare(
            'SELECT COUNT(*) as count FROM file_chunks'
        );

        // ── Populate in-memory caches from SQLite ───────────────────────

        const fpRows = this.sqliteDb.prepare(
            'SELECT id, filePath, sha256 FROM file_paths'
        ).all() as { id: number; filePath: string; sha256: string }[];

        for (const row of fpRows) {
            this.filePathCache.set(row.filePath, row.id);
            this.filePathIdToPath.set(row.id, row.filePath);
            if (row.sha256) {
                this.fileVersionCache.set(row.id, row.sha256);
            }
        }

        // ── LanceDB setup (vectors only) ────────────────────────────────

        const lancedb = await import('@lancedb/lancedb');
        const lanceDbPath = path.join(this.dbPath, LANCEDB_DIR);
        await fs.promises.mkdir(lanceDbPath, { recursive: true });
        this.lanceDb = await lancedb.connect(lanceDbPath);

        const tableNames = await this.lanceDb.tableNames();
        if (tableNames.includes(TBL_VECTORS)) {
            this.vectorsTable = await this.lanceDb.openTable(TBL_VECTORS);
            this.nextVectorId = await this.recoverNextVectorId();
        }

        // Create scalar indexes on vectors table (no-op if they already exist)
        await this.ensureVectorIndexes();

        log(`VectorDatabase: opened (${this.filePathCache.size} file paths loaded)`);
    }

    /**
     * Close the database connection and release resources.
     */
    async close(): Promise<void> {
        // Nullify prepared statements
        this.stmtInsertFilePath = null;
        this.stmtDeleteFilePath = null;
        this.stmtUpdateFileVersion = null;
        this.stmtInsertFileChunk = null;
        this.stmtDeleteFileChunkById = null;
        this.stmtDeleteChunksByFilePathId = null;
        this.stmtGetChunksByFilePathId = null;
        this.stmtGetChunkById = null;
        this.stmtUpdateChunkLines = null;
        this.stmtCountFileChunks = null;

        // Close SQLite
        this.sqliteDb?.close();
        this.sqliteDb = null;

        // Close LanceDB
        this.vectorsTable?.close();
        this.vectorsTable = null;
        this.lanceDb?.close();
        this.lanceDb = null;

        // Clear caches
        this.filePathCache.clear();
        this.filePathIdToPath.clear();
        this.fileVersionCache.clear();
    }

    // ── Insert ──────────────────────────────────────────────────────────────

    /**
     * Add multiple FileChunks to the database in a single batch.
     *
     * For each chunk this method will:
     *   1. Pre-allocate vectorIds (LanceDB has no auto-increment)
     *   2. Insert metadata (file paths + file chunks) into SQLite
     *   3. Insert embedding vectors into LanceDB
     *
     * If the LanceDB insert fails, the committed SQLite rows are deleted
     * to maintain cross-database consistency.
     *
     * @returns An array of the assigned FileChunk ids (in insertion order).
     */
    async addFileChunks(chunks: FileChunkInput[]): Promise<number[]> {
        if (chunks.length === 0) {
            return [];
        }

        this.ensureOpen();

        // 1. Pre-allocate vector IDs (LanceDB has no auto-increment)
        const vectorIds: number[] = [];
        for (let i = 0; i < chunks.length; i++) {
            vectorIds.push(this.nextVectorId++);
        }

        // 2. Insert all metadata into SQLite in a single transaction:
        //    new file paths (if any) + all file chunks
        const fileChunkIds: number[] = [];
        const newFilePaths: string[] = []; // Track for cache rollback

        this.sqliteDb!.exec('BEGIN');
        try {
            for (let i = 0; i < chunks.length; i++) {
                // Ensure file path exists in file_paths table
                let filePathId = this.filePathCache.get(chunks[i].filePath);
                if (filePathId === undefined) {
                    // Insert the file path into the database and update caches.
                    // The sha256 should be an empty string since a valid sha256
                    // would imply that all chunks for this file have been
                    // processed which is not known at this point.
                    const fpResult = this.stmtInsertFilePath!.run(chunks[i].filePath, '');
                    filePathId = fpResult.lastInsertRowid as number;
                    this.filePathCache.set(chunks[i].filePath, filePathId);
                    this.filePathIdToPath.set(filePathId, chunks[i].filePath);
                    newFilePaths.push(chunks[i].filePath);
                }

                // Insert file chunk row
                const result = this.stmtInsertFileChunk!.run(
                    filePathId, chunks[i].startLine, chunks[i].endLine,
                    chunks[i].sha256, vectorIds[i],
                );
                fileChunkIds.push(result.lastInsertRowid as number);
            }
            this.sqliteDb!.exec('COMMIT');
        } catch (err) {
            this.sqliteDb!.exec('ROLLBACK');
            // Evict new file path cache entries (they were rolled back)
            for (const fp of newFilePaths) {
                const fpId = this.filePathCache.get(fp);
                this.filePathCache.delete(fp);
                if (fpId !== undefined) {
                    this.filePathIdToPath.delete(fpId);
                }
            }
            this.nextVectorId -= chunks.length;
            throw err;
        }

        // 3. Insert vectors into LanceDB
        try {
            await this.insertVectors(
                chunks.map(c => c.vector),
                vectorIds,
                fileChunkIds,
            );
        } catch (err) {
            // LanceDB insert failed — delete the SQLite rows we just
            // committed to maintain cross-database consistency.
            // Orphaned file_paths (if any were created) are left in
            // place intentionally: they remain in both SQLite and
            // the in-memory cache, so the two stay in sync.  On a
            // retry the cache hit avoids a UNIQUE constraint violation.
            // checkIntegrity() cleans them up at next startup.
            this.sqliteDb!.exec('BEGIN');
            try {
                for (const id of fileChunkIds) {
                    this.stmtDeleteFileChunkById!.get(id);
                }
                this.sqliteDb!.exec('COMMIT');
            } catch {
                this.sqliteDb!.exec('ROLLBACK');
            }
            throw err;
        }

        log(`VectorDatabase: added ${chunks.length} file chunk(s)`);
        return fileChunkIds;
    }

    // ── Delete ──────────────────────────────────────────────────────────────

    /**
     * Delete everything associated with one or more file paths: all
     * FileChunks, their vectors, and the FilePath entries themselves.
     *
     * After this call the file paths will no longer exist in the
     * database or in the in-memory caches.
     */
    async deleteByFilePaths(filePaths: string[]): Promise<void> {
        if (filePaths.length === 0) {
            return;
        }

        this.ensureOpen();

        // Resolve file paths to filePathIds, skipping unknown paths
        const filePathIds: number[] = [];
        const resolvedPaths: string[] = [];
        for (const fp of filePaths) {
            const id = this.filePathCache.get(fp);
            if (id !== undefined) {
                filePathIds.push(id);
                resolvedPaths.push(fp);
            }
        }

        if (filePathIds.length === 0) {
            return;
        }

        // Delete file chunks (collecting vectorIds via RETURNING)
        // and file path entries in a single SQLite transaction
        const vectorIdsToDelete: number[] = [];
        this.sqliteDb!.exec('BEGIN');
        try {
            for (const fpId of filePathIds) {
                // DELETE ... RETURNING collects vectorIds and deletes
                // chunks in a single pass per file path
                const rows = this.stmtDeleteChunksByFilePathId!.all(fpId) as { vectorId: number }[];
                for (const r of rows) {
                    vectorIdsToDelete.push(r.vectorId);
                }
                this.stmtDeleteFilePath!.run(fpId);
            }
            this.sqliteDb!.exec('COMMIT');
        } catch (err) {
            this.sqliteDb!.exec('ROLLBACK');
            throw err;
        }

        // Evict from in-memory caches
        for (let i = 0; i < resolvedPaths.length; i++) {
            this.filePathCache.delete(resolvedPaths[i]);
            this.filePathIdToPath.delete(filePathIds[i]);
            this.fileVersionCache.delete(filePathIds[i]);
        }

        // Delete vectors from LanceDB (orphaned vectors are harmless
        // if this fails — cleaned up by checkIntegrity())
        if (this.vectorsTable && vectorIdsToDelete.length > 0) {
            try {
                const vecIdList = vectorIdsToDelete.join(', ');
                await this.vectorsTable.delete(`id IN (${vecIdList})`);
            } catch (err) {
                warn(`VectorDatabase: failed to delete ${vectorIdsToDelete.length} vector(s): ${err}`);
            }
        }
    }

    /**
     * Delete multiple FileChunks by their ids in a single pass.
     *
     * Uses DELETE ... RETURNING to collect vectorIds and delete chunks
     * atomically, then removes associated vectors from LanceDB.
     */
    async deleteFileChunks(fileChunkIds: number[]): Promise<void> {
        if (fileChunkIds.length === 0) {
            return;
        }
        this.ensureOpen();

        // Delete file chunks from SQLite, collecting vectorIds via RETURNING
        const vectorIdsToDelete: number[] = [];
        this.sqliteDb!.exec('BEGIN');
        try {
            for (const id of fileChunkIds) {
                const row = this.stmtDeleteFileChunkById!.get(id) as { vectorId: number } | undefined;
                if (row) {
                    vectorIdsToDelete.push(row.vectorId);
                }
            }
            this.sqliteDb!.exec('COMMIT');
        } catch (err) {
            this.sqliteDb!.exec('ROLLBACK');
            throw err;
        }

        // Delete vectors from LanceDB
        if (this.vectorsTable && vectorIdsToDelete.length > 0) {
            try {
                const vecIdList = vectorIdsToDelete.join(', ');
                await this.vectorsTable.delete(`id IN (${vecIdList})`);
            } catch (err) {
                warn(`VectorDatabase: failed to delete ${vectorIdsToDelete.length} vector(s): ${err}`);
            }
        }
    }

    // ── Update ──────────────────────────────────────────────────────────────

    /**
     * Update the start and end line numbers for multiple FileChunks
     * in a single batch operation.
     *
     * Only the line metadata is changed — the vector remains untouched.
     *
     * @param updates — FileChunkRecords with updated line numbers.
     */
    async updateFileChunkLines(updates: FileChunkRecord[]): Promise<void> {
        if (updates.length === 0) {
            return;
        }
        this.ensureOpen();

        this.sqliteDb!.exec('BEGIN');
        try {
            for (const u of updates) {
                this.stmtUpdateChunkLines!.run(u.startLine, u.endLine, u.id);
            }
            this.sqliteDb!.exec('COMMIT');
        } catch (err) {
            this.sqliteDb!.exec('ROLLBACK');
            throw err;
        }
    }

    /**
     * Set the source-file SHA-256 for one or more file paths.
     *
     * The sha256 column in the file_paths table records the SHA-256 of
     * the source file that was used to produce the chunks stored in the
     * database. A non-empty sha256 means "all chunks are valid for this
     * file version"; an empty string means "some or all chunks are invalid."
     *
     * Only updates existing file paths — unknown paths are silently
     * skipped. File paths are always created by {@link addFileChunks}
     * before this method is called.
     */
    async setFileVersions(updates: { filePath: string; sha256: string }[]): Promise<void> {
        if (updates.length === 0) {
            return;
        }
        this.ensureOpen();

        // Resolve filePaths to filePathIds, skipping unknown paths
        const rows: { filePathId: number; sha256: string }[] = [];
        for (const u of updates) {
            const filePathId = this.filePathCache.get(u.filePath);
            if (filePathId === undefined) {
                continue;
            }
            rows.push({ filePathId, sha256: u.sha256 });
        }

        if (rows.length === 0) {
            return;
        }

        this.sqliteDb!.exec('BEGIN');
        try {
            for (const row of rows) {
                this.stmtUpdateFileVersion!.run(row.sha256, row.filePathId);
            }
            this.sqliteDb!.exec('COMMIT');
        } catch (err) {
            this.sqliteDb!.exec('ROLLBACK');
            throw err;
        }

        // Update the in-memory cache
        for (const row of rows) {
            this.fileVersionCache.set(row.filePathId, row.sha256);
        }
    }

    // ── Search ──────────────────────────────────────────────────────────────

    /**
     * Find the nearest FileChunks to a query vector.
     *
     * Performs a vector similarity search on the LanceDB Vectors table,
     * then resolves fileChunkId → metadata via SQLite.
     *
     * @param queryVector — the embedding vector to search against.
     * @param topK — maximum number of FileChunk results to return (default 10).
     * @returns FileChunks ordered by ascending distance (_distance).
     */
    async getNearestFileChunks(
        queryVector: Float32Array,
        topK: number = 10,
    ): Promise<FileChunkSearchResult[]> {
        if (!this.vectorsTable || !this.sqliteDb) {
            return [];
        }

        // Vector search in LanceDB
        const vectorHits = await this.vectorsTable
            .vectorSearch(queryVector)
            .distanceType('cosine')
            .select(['id', 'fileChunkId'])
            .limit(topK)
            .toArray() as { id: number; fileChunkId: number; _distance: number }[];

        if (vectorHits.length === 0) {
            return [];
        }

        // Build distance map: fileChunkId → distance
        const distanceByChunkId = new Map<number, number>();
        for (const hit of vectorHits) {
            distanceByChunkId.set(hit.fileChunkId, hit._distance);
        }

        // Resolve file chunk metadata from SQLite
        // TODO: wrap in a transaction if this becomes a performance bottleneck
        const results: FileChunkSearchResult[] = [];
        for (const [chunkId, distance] of distanceByChunkId) {
            const row = this.stmtGetChunkById!.get(chunkId) as {
                id: number; filePathId: number;
                startLine: number; endLine: number; sha256: string;
            } | undefined;

            if (!row) {
                continue;
            }

            // Resolve filePathId → filePath from reverse cache
            const filePath = this.filePathIdToPath.get(row.filePathId);
            if (!filePath) {
                continue;
            }

            results.push({
                id: row.id,
                filePath,
                startLine: row.startLine,
                endLine: row.endLine,
                sha256: row.sha256,
                _distance: distance,
            });
        }

        // Sort by distance ascending
        results.sort((a, b) => a._distance - b._distance);
        return results;
    }

    // ── Query ───────────────────────────────────────────────────────────────

    /**
     * Get all file paths known to the database.
     *
     * Returns the keys of the in-memory cache that is populated at
     * {@link open} time — no database query is needed.
     *
     * @returns Array of absolute file path strings.
     */
    getAllFilePaths(): string[] {
        return Array.from(this.filePathCache.keys());
    }

    /**
     * Get the stored source-file SHA-256 for multiple file paths.
     *
     * @param filePaths — the file paths to look up.
     * @returns A Map from filePath → sha256. File paths with no stored
     *          version will not appear in the map.
     */
    async getFileVersions(filePaths: string[]): Promise<Map<string, string>> {
        const result = new Map<string, string>();

        for (const fp of filePaths) {
            const filePathId = this.filePathCache.get(fp);
            if (filePathId === undefined) {
                continue;
            }
            const sha256 = this.fileVersionCache.get(filePathId);
            if (sha256 !== undefined) {
                result.set(fp, sha256);
            }
        }

        return result;
    }

    /**
     * Get all FileChunks for multiple file paths.
     *
     * Uses a prepared statement loop inside a read transaction.
     * Each file path does a direct BTree index lookup on filePathId,
     * so cost is proportional to the total number of chunks returned.
     *
     * @param filePaths — the file paths to look up.
     * @returns A Map from filePath → array of FileChunkRecords.
     */
    async getFileChunksForMultipleFiles(filePaths: string[]): Promise<Map<string, FileChunkRecord[]>> {
        const result = new Map<string, FileChunkRecord[]>();

        if (!this.sqliteDb || filePaths.length === 0) {
            return result;
        }

        // Wrap reads in a transaction to avoid per-call implicit
        // transaction overhead in WAL mode
        this.sqliteDb.exec('BEGIN');
        try {
            for (const fp of filePaths) {
                const filePathId = this.filePathCache.get(fp);
                if (filePathId === undefined) {
                    continue;
                }

                const rows = this.stmtGetChunksByFilePathId!.all(filePathId) as {
                    id: number; filePathId: number;
                    startLine: number; endLine: number;
                    sha256: string; vectorId: number;
                }[];

                if (rows.length > 0) {
                    result.set(fp, rows.map(row => ({
                        id: row.id,
                        filePath: fp,
                        filePathId: row.filePathId,
                        startLine: row.startLine,
                        endLine: row.endLine,
                        sha256: row.sha256,
                        vectorId: row.vectorId,
                    })));
                }
            }
            this.sqliteDb.exec('COMMIT');
        } catch (err) {
            this.sqliteDb.exec('ROLLBACK');
            throw err;
        }

        return result;
    }

    /**
     * Get the total number of FileChunks in the database.
     */
    async countFileChunks(): Promise<number> {
        if (!this.sqliteDb) {
            return 0;
        }
        const row = this.stmtCountFileChunks!.get() as { count: number } | undefined;
        return row?.count ?? 0;
    }

    /**
     * Get the total number of vectors in the database.
     */
    async countVectors(): Promise<number> {
        if (!this.vectorsTable) {
            return 0;
        }
        return this.vectorsTable.countRows();
    }

    // ── Maintenance ─────────────────────────────────────────────────────────

    /**
     * Optimize the database storage.
     *
     *   - **SQLite**: WAL checkpoint — merges the WAL file back into
     *     the main database and truncates it to reclaim disk space.
     *   - **LanceDB**: Compacts data files, prunes old table versions,
     *     and updates scalar indices for the vectors table.
     *
     * Call this during idle periods or when a user explicitly requests it.
     */
    async compact(): Promise<void> {
        this.ensureOpen();

        // SQLite: WAL checkpoint
        try {
            this.sqliteDb!.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            log('VectorDatabase: SQLite WAL checkpoint complete');
        } catch (err) {
            error(`VectorDatabase: SQLite WAL checkpoint failed: ${err}`);
        }

        // LanceDB: optimize vectors table
        if (this.vectorsTable) {
            try {
                const stats = await this.vectorsTable.optimize();
                log(
                    `VectorDatabase: compacted vectors — removed ` +
                    `${stats.compaction.filesRemoved} files, ` +
                    `${stats.prune.bytesRemoved} bytes`
                );
            } catch (err) {
                error(`VectorDatabase: vectors compaction failed: ${err}`);
            }
        }
    }

    // ── Internals ───────────────────────────────────────────────────────────

    /**
     * Insert one or more vectors into the LanceDB Vectors table.
     *
     * @param vectors — the embedding vectors.
     * @param vectorIds — pre-allocated vector ids.
     * @param fileChunkIds — the FileChunk id each vector is linked to.
     */
    private async insertVectors(
        vectors: Float32Array[],
        vectorIds: number[],
        fileChunkIds: number[],
    ): Promise<void> {
        const rows = vectors.map((v, i) => ({
            id: vectorIds[i],
            vector: v,
            fileChunkId: fileChunkIds[i],
        }));

        if (!this.vectorsTable) {
            this.vectorsTable = await this.lanceDb!.createTable(TBL_VECTORS, rows);
            await this.createIndexSafe(this.vectorsTable, 'id');
            await this.createIndexSafe(this.vectorsTable, 'fileChunkId');
        } else {
            await this.vectorsTable.add(rows);
        }
    }

    /**
     * Assert that the database connections are open.
     */
    private ensureOpen(): void {
        if (!this.sqliteDb || !this.lanceDb) {
            throw new Error('VectorDatabase: database is not open — call open() first');
        }
    }

    /**
     * Recover the next vector id from the LanceDB vectors table.
     *
     * LanceDB has no auto-increment, so we scan the id column to find
     * the maximum. This only runs on startup when the table already exists.
     */
    private async recoverNextVectorId(): Promise<number> {
        if (!this.vectorsTable) {
            return 1;
        }
        const count = await this.vectorsTable.countRows();
        if (count === 0) {
            return 1;
        }
        // LanceDB has no ORDER BY or MAX(), so scan all ids
        const rows = await this.vectorsTable
            .query()
            .select(['id'])
            .toArray();
        let maxId = 0;
        for (const row of rows) {
            const val = (row as Record<string, number>)['id'];
            if (val > maxId) {
                maxId = val;
            }
        }
        return maxId + 1;
    }

    /**
     * Ensure scalar BTree indexes exist on the LanceDB vectors table.
     *
     * Uses `replace: false` so that existing indexes are left untouched.
     * Indexes are persisted on disk by LanceDB and survive across
     * open/close cycles.
     */
    private async ensureVectorIndexes(): Promise<void> {
        if (!this.vectorsTable) {
            return;
        }
        const t0 = Date.now();
        let count = 0;
        count += await this.createIndexSafe(this.vectorsTable, 'id');
        count += await this.createIndexSafe(this.vectorsTable, 'fileChunkId');
        if (count > 0) {
            log(`VectorDatabase: created ${count} vector index(es) in ${Date.now() - t0}ms`);
        }
    }

    /**
     * Create a scalar BTree index on a LanceDB column, ignoring errors
     * if the index already exists or the table is empty.
     *
     * @returns 1 if the index was created, 0 otherwise.
     */
    private async createIndexSafe(table: Table, column: string): Promise<number> {
        try {
            await table.createIndex(column, { replace: false });
            return 1;
        } catch {
            // Index already exists or table is too small — safe to ignore
            return 0;
        }
    }

    /**
     * Scan all tables for referential integrity violations and optionally
     * delete orphaned rows.
     *
     * Detects:
     *   1. Orphaned vectors    — Vectors (LanceDB) whose fileChunkId no
     *                            longer exists in file_chunks (SQLite).
     *   2. Orphaned file paths — file_paths rows that no file_chunk references.
     *   3. Dangling chunks     — file_chunks whose vectorId no longer
     *                            exists in Vectors (LanceDB).
     *
     * The check only reads lightweight id/FK columns — no vector data is
     * loaded — so the cost is proportional to the row count, not the
     * embedding dimension.
     *
     * @param repair — when `true`, delete every orphaned row that is found.
     * @returns Summary counts of the violations detected (before repair).
     */
    async checkIntegrity(repair: boolean = false): Promise<{
        orphanedVectors: number;
        orphanedFilePaths: number;
        danglingFileChunks: number;
    }> {
        this.ensureOpen();

        const result = {
            orphanedVectors: 0,
            orphanedFilePaths: 0,
            danglingFileChunks: 0,
        };

        // ── Collect id sets from LanceDB vectors table ──────────────────

        const vectorIds = new Set<number>();
        const vectorRows: { id: number; fileChunkId: number }[] = [];
        if (this.vectorsTable) {
            const rows = await this.vectorsTable
                .query()
                .select(['id', 'fileChunkId'])
                .toArray() as { id: number; fileChunkId: number }[];
            for (const r of rows) {
                vectorIds.add(r.id);
                vectorRows.push(r);
            }
        }

        // ── Collect id sets from SQLite file_chunks table ───────────────

        const fileChunkIds = new Set<number>();
        const fileChunkFilePathIds = new Set<number>();
        const chunkRows = this.sqliteDb!.prepare(
            'SELECT id, vectorId, filePathId FROM file_chunks'
        ).all() as { id: number; vectorId: number; filePathId: number }[];

        for (const r of chunkRows) {
            fileChunkIds.add(r.id);
            fileChunkFilePathIds.add(r.filePathId);
        }

        // ── File path ids from the in-memory cache ──────────────────────

        const filePathIds = new Set(this.filePathCache.values());

        // ── 1. Orphaned vectors — fileChunkId not in file_chunks ────────

        const orphanedVectorIds: number[] = [];
        for (const r of vectorRows) {
            if (!fileChunkIds.has(r.fileChunkId)) {
                orphanedVectorIds.push(r.id);
            }
        }
        result.orphanedVectors = orphanedVectorIds.length;

        // ── 2. Orphaned file paths — no file_chunk references them ──────

        const orphanedFilePathIds: number[] = [];
        for (const id of filePathIds) {
            if (!fileChunkFilePathIds.has(id)) {
                orphanedFilePathIds.push(id);
            }
        }
        result.orphanedFilePaths = orphanedFilePathIds.length;

        // ── 3. Dangling file chunks — vectorId not in Vectors ───────────

        const danglingChunkIds: number[] = [];
        for (const r of chunkRows) {
            if (!vectorIds.has(r.vectorId)) {
                danglingChunkIds.push(r.id);
            }
        }
        result.danglingFileChunks = danglingChunkIds.length;

        // ── Log summary ─────────────────────────────────────────────────

        const total = result.orphanedVectors
            + result.orphanedFilePaths
            + result.danglingFileChunks;

        if (total === 0) {
            log('VectorDatabase: integrity check passed — no orphans found');
            return result;
        }

        warn(
            `VectorDatabase: integrity check found ${total} issue(s): ` +
            `${result.orphanedVectors} orphaned vector(s), ` +
            `${result.orphanedFilePaths} orphaned file path(s), ` +
            `${result.danglingFileChunks} dangling file chunk(s)`
        );

        if (!repair) {
            return result;
        }

        // ── Repair ──────────────────────────────────────────────────────

        // Delete orphaned vectors from LanceDB
        if (this.vectorsTable && orphanedVectorIds.length > 0) {
            const idList = orphanedVectorIds.join(', ');
            await this.vectorsTable.delete(`id IN (${idList})`);
        }

        // Delete orphaned file paths and dangling file chunks from SQLite
        if (orphanedFilePathIds.length > 0 || danglingChunkIds.length > 0) {
            this.sqliteDb!.exec('BEGIN');
            try {
                for (const id of orphanedFilePathIds) {
                    this.stmtDeleteFilePath!.run(id);
                }
                for (const id of danglingChunkIds) {
                    this.stmtDeleteFileChunkById!.get(id);
                }
                this.sqliteDb!.exec('COMMIT');
            } catch (err) {
                this.sqliteDb!.exec('ROLLBACK');
                throw err;
            }

            // Evict orphaned file paths from in-memory caches
            for (const [fp, fpId] of this.filePathCache) {
                if (orphanedFilePathIds.includes(fpId)) {
                    this.filePathCache.delete(fp);
                    this.filePathIdToPath.delete(fpId);
                    this.fileVersionCache.delete(fpId);
                }
            }
        }

        log(`VectorDatabase: integrity repair complete — removed ${total} orphan(s)`);
        return result;
    }
}
