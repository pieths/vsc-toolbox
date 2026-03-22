// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * VectorDatabase — dual-storage database for file chunk metadata and embeddings.
 *
 * Storage:
 *
 *   SQLite (metadata.db, WAL mode):
 *     file_paths      — id (AUTOINCREMENT), filePath, sha256
 *     file_chunks     — id (AUTOINCREMENT), filePathId, startLine, endLine, sha256, vectorId
 *     deleted_chunks  — sha256 (PK), vectorId, touchedAt
 *
 *   LanceDB (vectors/ subdirectory):
 *     vectors         — id, vector (float32[], fixed dimension)
 *     deleted_vectors — id, vector (same schema as vectors)
 *
 * SQLite handles all scalar metadata operations (inserts, deletes, lookups,
 * updates) using prepared statements and transactions for maximum throughput.
 * LanceDB handles only vector storage and nearest-neighbor search.
 *
 * Vectors and FileChunks have a 1:1 relationship linked by vectorId
 * (file_chunks.vectorId → vectors.id). FilePaths stores both the file
 * path string and the source-file SHA-256 hash that the chunks were
 * generated from.
 *
 * When vectors are deleted, they are moved to the deleted_vectors table
 * and tracked by deleted_chunks (keyed by content sha256). If the same
 * content reappears (e.g., switching git branches), the vector is
 * restored from deleted_vectors instead of re-embedding.
 *
 * SQLite's AUTOINCREMENT handles id generation for file_paths and file_chunks,
 * eliminating the need for manual id counters and the meta.json persistence
 * file. The LanceDB vectors and deleted_vectors tables share a single manual
 * id counter (recovered from a scan of both tables on startup).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Connection, Table } from '@lancedb/lancedb';
import type { Table as ArrowTable } from 'apache-arrow';
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
    /** New embedding vector to insert into the vectors table */
    vector: Float32Array | null;
    /** Existing vector ID in the deleted_vectors table to restore */
    deletedVectorId: number | null;
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

/** LanceDB table name for deleted vectors (preserved for restore). */
const TBL_DELETED_VECTORS = 'deleted_vectors';

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
    private stmtGetChunksByFilePathId: ReturnType<DatabaseSync['prepare']> | null = null;
    private stmtGetChunkById: ReturnType<DatabaseSync['prepare']> | null = null;
    private stmtGetChunkByVectorId: ReturnType<DatabaseSync['prepare']> | null = null;
    private stmtUpdateChunkLines: ReturnType<DatabaseSync['prepare']> | null = null;
    private stmtCountFileChunks: ReturnType<DatabaseSync['prepare']> | null = null;
    private stmtInsertDeletedChunk: ReturnType<DatabaseSync['prepare']> | null = null;
    private stmtUpdateDeletedChunkTouchedAt: ReturnType<DatabaseSync['prepare']> | null = null;
    private stmtLookupDeletedChunk: ReturnType<DatabaseSync['prepare']> | null = null;
    private stmtDeleteDeletedChunkByTouchedAt: ReturnType<DatabaseSync['prepare']> | null = null;
    private stmtDeleteDeletedChunkBySha256: ReturnType<DatabaseSync['prepare']> | null = null;

    // ── LanceDB (vectors only) ──────────────────────────────────────────
    private lanceDb: Connection | null = null;
    private vectorsTable: Table | null = null;
    private deletedVectorsTable: Table | null = null;

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

        // 100MB page cache (25000 pages × 4KB) — sized to keep BTree
        // indexes and the deleted_chunks table resident in memory for
        // fast random lookups during vector restore and branch switching.
        this.sqliteDb.exec('PRAGMA cache_size = 25000');

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
        this.sqliteDb.exec(
            'CREATE INDEX IF NOT EXISTS idx_file_chunks_vectorId ON file_chunks(vectorId)'
        );

        this.sqliteDb.exec(`
            CREATE TABLE IF NOT EXISTS deleted_chunks (
                sha256 TEXT PRIMARY KEY,
                vectorId INTEGER NOT NULL,
                touchedAt INTEGER NOT NULL
            )
        `);
        this.sqliteDb.exec(
            'CREATE INDEX IF NOT EXISTS idx_deleted_chunks_touchedAt ON deleted_chunks(touchedAt)'
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
            'DELETE FROM file_chunks WHERE id = ?'
        );
        this.stmtGetChunksByFilePathId = this.sqliteDb.prepare(
            'SELECT id, filePathId, startLine, endLine, sha256, vectorId FROM file_chunks WHERE filePathId = ?'
        );
        this.stmtGetChunkById = this.sqliteDb.prepare(
            'SELECT id, filePathId, startLine, endLine, sha256 FROM file_chunks WHERE id = ?'
        );
        this.stmtGetChunkByVectorId = this.sqliteDb.prepare(
            'SELECT id, filePathId, startLine, endLine, sha256 FROM file_chunks WHERE vectorId = ?'
        );
        this.stmtUpdateChunkLines = this.sqliteDb.prepare(
            'UPDATE file_chunks SET startLine = ?, endLine = ? WHERE id = ?'
        );
        this.stmtCountFileChunks = this.sqliteDb.prepare(
            'SELECT COUNT(*) as count FROM file_chunks'
        );
        this.stmtInsertDeletedChunk = this.sqliteDb.prepare(
            'INSERT OR IGNORE INTO deleted_chunks (sha256, vectorId, touchedAt) VALUES (?, ?, ?)'
        );
        this.stmtUpdateDeletedChunkTouchedAt = this.sqliteDb.prepare(
            'UPDATE deleted_chunks SET touchedAt = ? WHERE sha256 = ?'
        );
        this.stmtLookupDeletedChunk = this.sqliteDb.prepare(
            'SELECT vectorId FROM deleted_chunks WHERE sha256 = ?'
        );
        this.stmtDeleteDeletedChunkByTouchedAt = this.sqliteDb.prepare(
            'DELETE FROM deleted_chunks WHERE touchedAt < ? RETURNING vectorId'
        );
        this.stmtDeleteDeletedChunkBySha256 = this.sqliteDb.prepare(
            'DELETE FROM deleted_chunks WHERE sha256 = ?'
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
        }
        if (tableNames.includes(TBL_DELETED_VECTORS)) {
            this.deletedVectorsTable = await this.lanceDb.openTable(TBL_DELETED_VECTORS);
        }
        this.nextVectorId = await this.recoverNextVectorId();

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
        this.stmtGetChunksByFilePathId = null;
        this.stmtGetChunkById = null;
        this.stmtGetChunkByVectorId = null;
        this.stmtUpdateChunkLines = null;
        this.stmtCountFileChunks = null;
        this.stmtInsertDeletedChunk = null;
        this.stmtUpdateDeletedChunkTouchedAt = null;
        this.stmtLookupDeletedChunk = null;
        this.stmtDeleteDeletedChunkByTouchedAt = null;
        this.stmtDeleteDeletedChunkBySha256 = null;

        // Close SQLite
        this.sqliteDb?.close();
        this.sqliteDb = null;

        // Close LanceDB
        this.vectorsTable?.close();
        this.vectorsTable = null;
        this.deletedVectorsTable?.close();
        this.deletedVectorsTable = null;
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
     * Supports two insertion modes per chunk:
     *   - **New embedding**: `vector` is set, `deletedVectorId` is null.
     *     Allocates a new vectorId and inserts into the `vectors` table.
     *   - **Restored embedding**: `deletedVectorId` is set, `vector` is null.
     *     Reuses the existing vectorId and copies the vector from
     *     `deleted_vectors` back into `vectors`.
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

        // Partition chunks into new embeddings vs restored embeddings
        const newEmbeddings: { index: number; chunk: FileChunkInput }[] = [];
        const restoredEmbeddings: { index: number; chunk: FileChunkInput }[] = [];

        for (let i = 0; i < chunks.length; i++) {
            if (chunks[i].deletedVectorId !== null) {
                restoredEmbeddings.push({ index: i, chunk: chunks[i] });
            } else {
                newEmbeddings.push({ index: i, chunk: chunks[i] });
            }
        }

        // Pre-allocate vector IDs only for new embeddings
        // (restored embeddings reuse their existing deletedVectorId)
        const vectorIdPerChunk: number[] = new Array(chunks.length);
        const newVectorCount = newEmbeddings.length;

        for (const entry of newEmbeddings) {
            vectorIdPerChunk[entry.index] = this.nextVectorId++;
        }
        for (const entry of restoredEmbeddings) {
            vectorIdPerChunk[entry.index] = entry.chunk.deletedVectorId!;
        }

        // Dispatch LanceDB operations to Tokio thread pool — restore
        // deleted vectors then insert new vectors, sequentially (both
        // write to the vectors table). The chain starts immediately,
        // freeing the JS thread for synchronous SQLite work below.
        const lancePromise = (async () => {
            if (restoredEmbeddings.length > 0) {
                await this.restoreDeletedVectors(
                    restoredEmbeddings.map(e => e.chunk.deletedVectorId!)
                );
            }
            if (newEmbeddings.length > 0) {
                await this.insertVectors(
                    newEmbeddings.map(e => e.chunk.vector!),
                    newEmbeddings.map(e => vectorIdPerChunk[e.index]),
                );
            }
        })();

        // Insert all metadata into SQLite in a single transaction:
        // file paths (if new) + file_chunks for ALL chunks.
        // Runs on the JS thread concurrently with the LanceDB chain above.
        const fileChunkIds: number[] = new Array(chunks.length);
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
                    chunks[i].sha256, vectorIdPerChunk[i],
                );
                fileChunkIds[i] = result.lastInsertRowid as number;
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
            this.nextVectorId -= newVectorCount;
            // Settle the Lance promise to prevent unhandled rejection.
            // Any orphaned vectors are cleaned up by checkIntegrity().
            await lancePromise.catch(() => { });
            throw err;
        }

        // Update touchedAt for restored chunks (synchronous SQLite,
        // still concurrent with the LanceDB chain on Tokio).
        if (restoredEmbeddings.length > 0) {
            this.sqliteDb!.exec('BEGIN');
            try {
                this.touchDeletedChunks(
                    restoredEmbeddings.map(e => e.chunk.sha256)
                );
                this.sqliteDb!.exec('COMMIT');
            } catch (err) {
                this.sqliteDb!.exec('ROLLBACK');
                // Non-fatal: touchedAt is only for purge ordering
                warn(`VectorDatabase: failed to touch restored deleted chunks: ${err}`);
            }
        }

        // Await the LanceDB chain (likely already done by now).
        try {
            await lancePromise;
        } catch (err) {
            // LanceDB failed — delete the SQLite file_chunks rows we
            // committed to maintain cross-database consistency.
            // Orphaned file_paths (if any were created) are left in
            // place intentionally: they remain in both SQLite and
            // the in-memory cache, so the two stay in sync.  On a
            // retry the cache hit avoids a UNIQUE constraint violation.
            // checkIntegrity() cleans them up at next startup.
            this.sqliteDb!.exec('BEGIN');
            try {
                for (const id of fileChunkIds) {
                    this.stmtDeleteFileChunkById!.run(id);
                }
                this.sqliteDb!.exec('COMMIT');
            } catch {
                this.sqliteDb!.exec('ROLLBACK');
            }
            throw err;
        }

        log(`VectorDatabase: added ${chunks.length} file chunk(s) (${newEmbeddings.length} new, ${restoredEmbeddings.length} restored)`);
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

        // Collect all FileChunkRecords for the file paths being deleted
        const storedChunksMap = await this.getFileChunksForMultipleFiles(resolvedPaths);
        const allChunks: FileChunkRecord[] = [];
        for (const chunks of storedChunksMap.values()) {
            for (const chunk of chunks) {
                allChunks.push(chunk);
            }
        }

        // Delegate chunk + vector deletion to deleteFileChunks
        // (handles deleted_chunks recording + vector move + vector delete)
        await this.deleteFileChunks(allChunks);

        // Delete file path entries in a single SQLite transaction
        this.sqliteDb!.exec('BEGIN');
        try {
            for (const fpId of filePathIds) {
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
    }

    /**
     * Delete multiple FileChunks in a single pass.
     *
     * Deletes the file_chunks rows from SQLite, moves the associated
     * vectors to the `deleted_vectors` table (preserving them for
     * potential restore), and removes them from the `vectors` table.
     *
     * Uses deferred-await parallelism: the LanceDB query is dispatched
     * to a Tokio thread first, then synchronous SQLite work runs on
     * the JS thread concurrently, then the LanceDB result is awaited.
     */
    async deleteFileChunks(chunks: FileChunkRecord[]): Promise<void> {
        if (chunks.length === 0) {
            return;
        }
        this.ensureOpen();

        // 1. Insert into deleted_chunks (SQLite) — determines which vectors are
        //    new and need a LanceDB move. Must run first so we know newVectorIds.
        const deletedChunkData = chunks.map(c => ({ sha256: c.sha256, vectorId: c.vectorId }));
        let newVectorIds: number[] = [];

        this.sqliteDb!.exec('BEGIN');
        try {
            newVectorIds = this.insertDeletedChunks(deletedChunkData);
            this.sqliteDb!.exec('COMMIT');
        } catch (err) {
            this.sqliteDb!.exec('ROLLBACK');
            throw err;
        }

        // 2. Retrieve the vectors from the LanceDB vectors table which are
        //    not in the deleted_vectors table (deleted_chunks maps 1:1 with
        //    deleted_vectors) — returns a Promise immediately to a Tokio
        //    thread, freeing the JS thread for the synchronous file_chunks
        //    delete below.
        let arrowPromise: Promise<ArrowTable> | null = null;
        if (this.vectorsTable && newVectorIds.length > 0) {
            arrowPromise = this.vectorsTable
                .query()
                .where(`id IN (${newVectorIds.join(',')})`)
                .toArrow();
        }

        // 3. While the Tokio thread does Lance file I/O + Arrow serialization,
        //    delete file_chunks rows from SQLite on the JS thread concurrently.
        this.sqliteDb!.exec('BEGIN');
        try {
            for (const chunk of chunks) {
                this.stmtDeleteFileChunkById!.run(chunk.id);
            }
            this.sqliteDb!.exec('COMMIT');
        } catch (err) {
            this.sqliteDb!.exec('ROLLBACK');
            // Settle the arrow promise to prevent unhandled rejection.
            // Any orphaned vectors are cleaned up by checkIntegrity().
            if (arrowPromise) {
                await arrowPromise.catch(() => {});
            }
            throw err;
        }

        // 4. Await the LanceDB arrow query result (likely already done by now).
        //    Then move new vectors to deleted_vectors and delete all vectors
        //    from the vectors table in parallel — they operate on separate
        //    Lance tables with no data dependency.
        const allVectorIds = chunks.map(c => c.vectorId);

        if (arrowPromise) {
            try {
                const arrowData = await arrowPromise;

                const movePromise = (async () => {
                    if (arrowData.numRows > 0) {
                        if (!this.deletedVectorsTable) {
                            this.deletedVectorsTable = await this.lanceDb!.createTable(
                                TBL_DELETED_VECTORS, arrowData,
                            );
                            await this.createIndexSafe(this.deletedVectorsTable, 'id');
                        } else {
                            await this.deletedVectorsTable.add(arrowData);
                        }
                    }
                })();

                const deletePromise = this.vectorsTable!.delete(
                    `id IN (${allVectorIds.join(', ')})`
                );

                await Promise.all([movePromise, deletePromise]);
            } catch (err) {
                warn(`VectorDatabase: failed to move/delete ${allVectorIds.length} vector(s): ${err}`);
            }
        } else if (this.vectorsTable && allVectorIds.length > 0) {
            // No new vectors to move, but still need to delete from vectors table
            try {
                await this.vectorsTable.delete(`id IN (${allVectorIds.join(', ')})`);
            } catch (err) {
                warn(`VectorDatabase: failed to delete ${allVectorIds.length} vector(s): ${err}`);
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
     * then resolves vectorId → file chunk metadata via SQLite.
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
            .select(['id'])
            .limit(topK)
            .toArray() as { id: number; _distance: number }[];

        if (vectorHits.length === 0) {
            return [];
        }

        // Build distance map: vectorId → distance
        const distanceByVectorId = new Map<number, number>();
        for (const hit of vectorHits) {
            distanceByVectorId.set(hit.id, hit._distance);
        }

        // Resolve file chunk metadata from SQLite via vectorId index
        const results: FileChunkSearchResult[] = [];
        for (const [vectorId, distance] of distanceByVectorId) {
            const row = this.stmtGetChunkByVectorId!.get(vectorId) as {
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
     * Check which chunk sha256s have previously-deleted vectors that
     * can be restored instead of re-embedded.
     *
     * @param sha256s — content hashes of chunks to check.
     * @returns A Map from sha256 → vectorId for chunks that have a
     *          preserved vector in `deleted_vectors`. Misses are omitted.
     */
    getDeletedVectors(sha256s: string[]): Map<string, number> {
        return this.lookupDeletedChunks(sha256s);
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
     * Optimize the database storage and purge old deleted vectors.
     *
     *   - **Purge**: Deletes `deleted_chunks` entries where `touchedAt`
     *     is older than `purgeAgeDays`, and removes their corresponding
     *     vectors from the `deleted_vectors` LanceDB table.
     *   - **SQLite**: WAL checkpoint — merges the WAL file back into
     *     the main database and truncates it to reclaim disk space.
     *   - **LanceDB**: Compacts data files, prunes old table versions,
     *     and updates scalar indices for the vectors and deleted_vectors
     *     tables.
     *
     * Call this during idle periods or when a user explicitly requests it.
     *
     * @param purgeAgeDays — entries in `deleted_chunks` older than this
     *                       many days are purged. Defaults to 30 days.
     */
    async compact(purgeAgeDays: number = 30): Promise<void> {
        this.ensureOpen();

        // Purge old deleted_chunks and their corresponding deleted_vectors
        try {
            const cutoff = Math.floor(Date.now() / 1000) - (purgeAgeDays * 86400);
            const rows = this.stmtDeleteDeletedChunkByTouchedAt!.all(cutoff) as { vectorId: number }[];

            if (rows.length > 0) {
                const vectorIds = rows.map(r => r.vectorId);

                if (this.deletedVectorsTable) {
                    await this.deletedVectorsTable.delete(
                        `id IN (${vectorIds.join(', ')})`
                    );
                }

                log(`VectorDatabase: purged ${rows.length} deleted chunk(s) older than ${purgeAgeDays} days`);
            }
        } catch (err) {
            error(`VectorDatabase: deleted_chunks purge failed: ${err}`);
        }

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

        // LanceDB: optimize deleted_vectors table
        if (this.deletedVectorsTable) {
            try {
                const stats = await this.deletedVectorsTable.optimize();
                log(
                    `VectorDatabase: compacted deleted_vectors — removed ` +
                    `${stats.compaction.filesRemoved} files, ` +
                    `${stats.prune.bytesRemoved} bytes`
                );
            } catch (err) {
                error(`VectorDatabase: deleted_vectors compaction failed: ${err}`);
            }
        }
    }

    // ── Internals ───────────────────────────────────────────────────────────

    /**
     * Insert one or more vectors into the LanceDB Vectors table.
     *
     * @param vectors — the embedding vectors.
     * @param vectorIds — pre-allocated vector ids.
     */
    private async insertVectors(
        vectors: Float32Array[],
        vectorIds: number[],
    ): Promise<void> {
        const rows = vectors.map((v, i) => ({
            id: vectorIds[i],
            vector: v,
        }));

        if (!this.vectorsTable) {
            this.vectorsTable = await this.lanceDb!.createTable(TBL_VECTORS, rows);
            await this.createIndexSafe(this.vectorsTable, 'id');
        } else {
            await this.vectorsTable.add(rows);
        }
    }

    /**
     * Record deleted chunks in the `deleted_chunks` SQLite table.
     *
     * Uses `INSERT OR IGNORE` to avoid duplicates. If a row with the
     * same `sha256` already exists, only the `touchedAt` timestamp is
     * refreshed — the vector is already in `deleted_vectors` and does
     * not need to be moved again.
     *
     * @param chunks — the chunks being deleted, each with `sha256` and `vectorId`.
     * @returns The vectorIds of chunks that are **new** to `deleted_chunks`
     *          (i.e. their vectors still need to be moved to `deleted_vectors`).
     *          Chunks that already existed are excluded from this list.
     */
    private insertDeletedChunks(chunks: { sha256: string; vectorId: number }[]): number[] {
        const now = Math.floor(Date.now() / 1000);
        const newVectorIds: number[] = [];

        for (const chunk of chunks) {
            const result = this.stmtInsertDeletedChunk!.run(chunk.sha256, chunk.vectorId, now);
            if (result.changes === 1) {
                // New row — vector needs to be moved to deleted_vectors
                newVectorIds.push(chunk.vectorId);
            } else {
                // Already existed — just refresh the timestamp
                this.stmtUpdateDeletedChunkTouchedAt!.run(now, chunk.sha256);
            }
        }

        return newVectorIds;
    }

    /**
     * Look up sha256 hashes in the `deleted_chunks` table to find
     * vectors that were previously deleted and preserved.
     *
     * @param sha256s — content hashes to look up.
     * @returns A Map from sha256 → vectorId for hits. Misses are omitted.
     */
    private lookupDeletedChunks(sha256s: string[]): Map<string, number> {
        const result = new Map<string, number>();
        this.sqliteDb!.exec('BEGIN');
        try {
            for (const sha256 of sha256s) {
                const row = this.stmtLookupDeletedChunk!.get(sha256) as { vectorId: number } | undefined;
                if (row) {
                    result.set(sha256, row.vectorId);
                }
            }
            this.sqliteDb!.exec('COMMIT');
        } catch (err) {
            this.sqliteDb!.exec('ROLLBACK');
            throw err;
        }
        return result;
    }

    /**
     * Copy vectors from `deleted_vectors` back into the `vectors` table.
     *
     * Uses `toArrow()` → `add()` for zero-copy Arrow transfer between
     * tables. Async (LanceDB only) — a natural candidate for deferred-await
     * parallelism with synchronous SQLite work.
     *
     * @param deletedVectorIds — the vector IDs to restore from `deleted_vectors`.
     */
    private async restoreDeletedVectors(deletedVectorIds: number[]): Promise<void> {
        if (deletedVectorIds.length === 0 || !this.deletedVectorsTable) {
            return;
        }

        const arrowData = await this.deletedVectorsTable
            .query()
            .where(`id IN (${deletedVectorIds.join(',')})`)
            .toArrow();

        if (arrowData.numRows === 0) {
            return;
        }

        if (!this.vectorsTable) {
            this.vectorsTable = await this.lanceDb!.createTable(TBL_VECTORS, arrowData);
            await this.createIndexSafe(this.vectorsTable, 'id');
        } else {
            await this.vectorsTable.add(arrowData);
        }
    }

    /**
     * Refresh the `touchedAt` timestamp for restored chunks in `deleted_chunks`.
     *
     * Called after a successful restore to record that the chunk was recently
     * active. This prevents age-based purging from removing frequently-used
     * chunks.
     *
     * Synchronous (SQLite only). Expects to be called within a transaction
     * managed by the caller, or runs each update in an implicit transaction.
     *
     * @param sha256s — content hashes of the restored chunks.
     */
    private touchDeletedChunks(sha256s: string[]): void {
        const now = Math.floor(Date.now() / 1000);
        for (const sha256 of sha256s) {
            this.stmtUpdateDeletedChunkTouchedAt!.run(now, sha256);
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
     * Recover the next vector id by scanning both LanceDB tables.
     *
     * Both `vectors` and `deleted_vectors` share a single ID space.
     * On startup we scan the `id` column of each table and take the
     * maximum to ensure IDs are never reused across both tables.
     */
    private async recoverNextVectorId(): Promise<number> {
        const maxMain = await this.recoverMaxId(this.vectorsTable);
        const maxDeleted = await this.recoverMaxId(this.deletedVectorsTable);
        return Math.max(maxMain, maxDeleted) + 1;
    }

    /**
     * Scan a single LanceDB table for the maximum `id` value.
     *
     * @returns The maximum id found, or 0 if the table is null or empty.
     */
    private async recoverMaxId(table: Table | null): Promise<number> {
        if (!table) {
            return 0;
        }
        const count = await table.countRows();
        if (count === 0) {
            return 0;
        }
        // LanceDB has no ORDER BY or MAX(), so scan all ids
        const rows = await table
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
        return maxId;
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
     *   1. Orphaned vectors         — Vectors (LanceDB) whose id is not
     *                                  referenced by any file_chunks.vectorId.
     *   2. Orphaned file paths      — file_paths rows that no file_chunk references.
     *   3. Dangling chunks          — file_chunks whose vectorId no longer
     *                                  exists in Vectors (LanceDB).
     *   4. Orphaned deleted vectors — deleted_vectors (LanceDB) whose id
     *                                  is not referenced by any deleted_chunks.vectorId.
     *   5. Dangling deleted chunks  — deleted_chunks whose vectorId no longer
     *                                  exists in deleted_vectors (LanceDB).
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
        orphanedDeletedVectors: number;
        danglingDeletedChunks: number;
    }> {
        this.ensureOpen();

        const result = {
            orphanedVectors: 0,
            orphanedFilePaths: 0,
            danglingFileChunks: 0,
            orphanedDeletedVectors: 0,
            danglingDeletedChunks: 0,
        };

        // ── Collect id sets from LanceDB vectors table ──────────────────

        const vectorIds = new Set<number>();
        if (this.vectorsTable) {
            const rows = await this.vectorsTable
                .query()
                .select(['id'])
                .toArray() as { id: number }[];
            for (const r of rows) {
                vectorIds.add(r.id);
            }
        }

        // ── Collect id sets from SQLite file_chunks table ───────────────

        const fileChunkVectorIds = new Set<number>();
        const fileChunkFilePathIds = new Set<number>();
        const chunkRows = this.sqliteDb!.prepare(
            'SELECT id, vectorId, filePathId FROM file_chunks'
        ).all() as { id: number; vectorId: number; filePathId: number }[];

        for (const r of chunkRows) {
            fileChunkVectorIds.add(r.vectorId);
            fileChunkFilePathIds.add(r.filePathId);
        }

        // ── File path ids from the in-memory cache ──────────────────────

        const filePathIds = new Set(this.filePathCache.values());

        // ── 1. Orphaned vectors — id not referenced by any file_chunk ───

        const orphanedVectorIds: number[] = [];
        for (const id of vectorIds) {
            if (!fileChunkVectorIds.has(id)) {
                orphanedVectorIds.push(id);
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

        // ── Collect id sets from LanceDB deleted_vectors table ──────────

        const deletedVectorIds = new Set<number>();
        if (this.deletedVectorsTable) {
            const rows = await this.deletedVectorsTable
                .query()
                .select(['id'])
                .toArray() as { id: number }[];
            for (const r of rows) {
                deletedVectorIds.add(r.id);
            }
        }

        // ── Collect vectorIds from SQLite deleted_chunks table ───────────

        const deletedChunkRows = this.sqliteDb!.prepare(
            'SELECT sha256, vectorId FROM deleted_chunks'
        ).all() as { sha256: string; vectorId: number }[];

        const deletedChunkVectorIds = new Set<number>();
        for (const r of deletedChunkRows) {
            deletedChunkVectorIds.add(r.vectorId);
        }

        // ── 4. Orphaned deleted vectors — id not in deleted_chunks ──────

        const orphanedDeletedVectorIds: number[] = [];
        for (const id of deletedVectorIds) {
            if (!deletedChunkVectorIds.has(id)) {
                orphanedDeletedVectorIds.push(id);
            }
        }
        result.orphanedDeletedVectors = orphanedDeletedVectorIds.length;

        // ── 5. Dangling deleted chunks — vectorId not in deleted_vectors ─

        const danglingDeletedChunkSha256s: string[] = [];
        for (const r of deletedChunkRows) {
            if (!deletedVectorIds.has(r.vectorId)) {
                danglingDeletedChunkSha256s.push(r.sha256);
            }
        }
        result.danglingDeletedChunks = danglingDeletedChunkSha256s.length;

        // ── Log summary ─────────────────────────────────────────────────

        const total = result.orphanedVectors
            + result.orphanedFilePaths
            + result.danglingFileChunks
            + result.orphanedDeletedVectors
            + result.danglingDeletedChunks;

        if (total === 0) {
            log('VectorDatabase: integrity check passed — no orphans found');
            return result;
        }

        warn(
            `VectorDatabase: integrity check found ${total} issue(s): ` +
            `${result.orphanedVectors} orphaned vector(s), ` +
            `${result.orphanedFilePaths} orphaned file path(s), ` +
            `${result.danglingFileChunks} dangling file chunk(s), ` +
            `${result.orphanedDeletedVectors} orphaned deleted vector(s), ` +
            `${result.danglingDeletedChunks} dangling deleted chunk(s)`
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

        // Delete orphaned deleted vectors from LanceDB
        if (this.deletedVectorsTable && orphanedDeletedVectorIds.length > 0) {
            const idList = orphanedDeletedVectorIds.join(', ');
            await this.deletedVectorsTable.delete(`id IN (${idList})`);
        }

        // Delete orphaned file paths, dangling file chunks, and dangling
        // deleted chunks from SQLite
        if (orphanedFilePathIds.length > 0 || danglingChunkIds.length > 0 ||
            danglingDeletedChunkSha256s.length > 0) {
            this.sqliteDb!.exec('BEGIN');
            try {
                for (const id of orphanedFilePathIds) {
                    this.stmtDeleteFilePath!.run(id);
                }
                for (const id of danglingChunkIds) {
                    this.stmtDeleteFileChunkById!.run(id);
                }
                for (const sha256 of danglingDeletedChunkSha256s) {
                    this.stmtDeleteDeletedChunkBySha256!.run(sha256);
                }
                this.sqliteDb!.exec('COMMIT');
            } catch (err) {
                this.sqliteDb!.exec('ROLLBACK');
                throw err;
            }

            // Evict orphaned file paths from in-memory caches
            const orphanedFilePathIdSet = new Set(orphanedFilePathIds);
            for (const [fp, fpId] of this.filePathCache) {
                if (orphanedFilePathIdSet.has(fpId)) {
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
