// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * VectorDatabase — a wrapper around a LanceDB database instance.
 *
 * Tables:
 *
 *   Vectors       — id, vector (float32[], fixed dimension), fileChunkId
 *   FileChunks    — id, filePathId, startLine, endLine, sha256, vectorId
 *   FilePaths     — id, filePath, sha256  (source file version)
 *
 * Vectors and FileChunks have a 1:1 relationship via their mutual
 * foreign keys (vectorId ↔ fileChunkId).  FilePaths stores both the
 * file path string and the source-file SHA-256 hash that the chunks
 * were generated from.
 *
 * LanceDB stores data in the Lance columnar format on disk and memory-maps
 * it at query time.  Vectors never enter the V8 heap, so this works within
 * the Electron extension host memory limits.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Connection, Table } from '@lancedb/lancedb';
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

const TBL_VECTORS = 'vectors';
const TBL_FILE_PATHS = 'file_paths';
const TBL_FILE_CHUNKS = 'file_chunks';

/** Name of the JSON file that persists auto-increment counters. */
const META_FILE = 'meta.json';

/** Shape of the persisted metadata. */
interface DatabaseMeta {
    nextVectorId: number;
    nextFilePathId: number;
    nextFileChunkId: number;
}

// ── Class ───────────────────────────────────────────────────────────────────

export class VectorDatabase {
    private readonly dbPath: string;
    private readonly vectorDimension: number;
    private db: Connection | null = null;

    private vectorsTable: Table | null = null;
    private filePathsTable: Table | null = null;
    private fileChunksTable: Table | null = null;

    private nextVectorId: number = 1;
    private nextFilePathId: number = 1;
    private nextFileChunkId: number = 1;

    /** In-memory cache mapping filePath → filePathId for fast lookups. */
    private filePathCache = new Map<string, number>();

    /** In-memory cache mapping filePathId → sha256 for file version lookups. */
    private fileVersionCache = new Map<number, string>();

    /**
     * Create a VectorDatabase instance.
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
     * Open (or create) the database and all tables.
     *
     * If tables already exist on disk they will be opened and the next
     * auto-increment ids will be recovered from the existing data.
     */
    async open(): Promise<void> {
        const lancedb = await import('@lancedb/lancedb');

        await fs.promises.mkdir(this.dbPath, { recursive: true });
        this.db = await lancedb.connect(this.dbPath);

        const tableNames = await this.db.tableNames();

        // ── Try to load persisted metadata ───────────────────────────────
        const meta = await this.loadMeta();

        // ── Vectors ─────────────────────────────────────────────────────
        if (tableNames.includes(TBL_VECTORS)) {
            this.vectorsTable = await this.db.openTable(TBL_VECTORS);
            if (!meta) {
                this.nextVectorId = await this.recoverNextId(this.vectorsTable, 'id');
            }
        }

        // ── FilePaths ───────────────────────────────────────────────────
        if (tableNames.includes(TBL_FILE_PATHS)) {
            this.filePathsTable = await this.db.openTable(TBL_FILE_PATHS);
            if (!meta) {
                this.nextFilePathId = await this.recoverNextId(this.filePathsTable, 'id');
            }
            // Populate the in-memory caches
            const fpRows = await this.filePathsTable
                .query()
                .select(['id', 'filePath', 'sha256'])
                .toArray() as { id: number; filePath: string; sha256: string }[];
            for (const row of fpRows) {
                this.filePathCache.set(row.filePath, row.id);
                if (row.sha256) {
                    this.fileVersionCache.set(row.id, row.sha256);
                }
            }
        }

        // ── FileChunks ──────────────────────────────────────────────────
        if (tableNames.includes(TBL_FILE_CHUNKS)) {
            this.fileChunksTable = await this.db.openTable(TBL_FILE_CHUNKS);
            if (!meta) {
                this.nextFileChunkId = await this.recoverNextId(this.fileChunksTable, 'id');
            }
        }

        if (meta) {
            this.nextVectorId = meta.nextVectorId;
            this.nextFilePathId = meta.nextFilePathId;
            this.nextFileChunkId = meta.nextFileChunkId;
            log('VectorDatabase: opened (ids restored from metadata)');
        } else {
            log('VectorDatabase: opened (ids recovered from table scan)');
        }

        // Create scalar indexes on existing tables (no-op if they already exist)
        await this.ensureScalarIndexes();
    }

    /**
     * Close the database connection and release resources.
     */
    async close(): Promise<void> {
        await this.saveMeta();

        const tables = [
            this.vectorsTable,
            this.filePathsTable,
            this.fileChunksTable,
        ];
        for (const t of tables) {
            t?.close();
        }
        this.vectorsTable = null;
        this.filePathsTable = null;
        this.fileChunksTable = null;

        this.db?.close();
        this.db = null;

        this.filePathCache.clear();
        this.fileVersionCache.clear();
    }

    // ── Insert ──────────────────────────────────────────────────────────────

    /**
     * Add multiple FileChunks to the database in a single batch.
     *
     * For each chunk this method will:
     *   1. Ensure the filePath exists in FilePaths → filePathId
     *   2. Pre-allocate fileChunkId and vectorId
     *   3. Insert the FileChunk
     *   4. Insert the embedding vector into Vectors (with fileChunkId)
     *
     * @returns An array of the assigned FileChunk ids (in insertion order).
     */
    async addFileChunks(chunks: FileChunkInput[]): Promise<number[]> {
        if (chunks.length === 0) {
            return [];
        }

        this.ensureOpen();

        // 1. Ensure file paths exist
        const filePathIds = await this.ensureFilePaths(chunks.map(c => c.filePath));

        // 2. Pre-allocate ids for both tables
        const fileChunkIds: number[] = [];
        const vectorIds: number[] = [];
        for (let i = 0; i < chunks.length; i++) {
            fileChunkIds.push(this.nextFileChunkId++);
            vectorIds.push(this.nextVectorId++);
        }

        // 3. Insert FileChunks
        const fileChunkRows = chunks.map((chunk, i) => ({
            id: fileChunkIds[i],
            filePathId: filePathIds[i],
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            sha256: chunk.sha256,
            vectorId: vectorIds[i],
        }));

        if (!this.fileChunksTable) {
            this.fileChunksTable = await this.db!.createTable(TBL_FILE_CHUNKS, fileChunkRows);
            await this.createIndexSafe(this.fileChunksTable, 'id');
            await this.createIndexSafe(this.fileChunksTable, 'filePathId');
        } else {
            await this.fileChunksTable.add(fileChunkRows);
        }

        // 4. Insert Vectors (with fileChunkId)
        await this.insertVectors(
            chunks.map(c => c.vector),
            vectorIds,
            fileChunkIds,
        );

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
        if (!this.fileChunksTable || !this.filePathsTable || filePaths.length === 0) {
            return;
        }

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

        // Find all FileChunk ids for these files in one query
        const fpIdList = filePathIds.join(', ');
        const chunkRows = await this.fileChunksTable
            .query()
            .select(['id'])
            .where(`filePathId IN (${fpIdList})`)
            .toArray() as { id: number }[];

        // Delete all chunks (and their vectors) in one batch
        if (chunkRows.length > 0) {
            await this.deleteFileChunks(chunkRows.map(r => r.id));
        }

        // Delete the FilePath entries in one query
        await this.filePathsTable.delete(`id IN (${fpIdList})`);

        // Evict from in-memory caches
        for (let i = 0; i < resolvedPaths.length; i++) {
            this.filePathCache.delete(resolvedPaths[i]);
            this.fileVersionCache.delete(filePathIds[i]);
        }
    }

    /**
     * Delete multiple FileChunks by their ids in a single pass.
     *
     * Also removes associated vectors.
     */
    async deleteFileChunks(fileChunkIds: number[]): Promise<void> {
        if (fileChunkIds.length === 0) {
            return;
        }
        this.ensureOpen();

        const idList = fileChunkIds.join(', ');

        // Collect vectorIds to delete
        const vectorIdsToDelete = new Set<number>();

        if (this.fileChunksTable) {
            const chunkRows = await this.fileChunksTable
                .query()
                .select(['vectorId'])
                .where(`id IN (${idList})`)
                .toArray() as { vectorId: number }[];
            for (const r of chunkRows) {
                vectorIdsToDelete.add(r.vectorId);
            }

            // Delete file chunks
            await this.fileChunksTable.delete(`id IN (${idList})`);
        }

        // Delete vectors
        if (this.vectorsTable && vectorIdsToDelete.size > 0) {
            const vecIdList = Array.from(vectorIdsToDelete).join(', ');
            await this.vectorsTable.delete(`id IN (${vecIdList})`);
        }
    }

    // ── Update ──────────────────────────────────────────────────────────────

    /**
     * Update the start and end line numbers for multiple FileChunks
     * in a single batch operation.
     *
     * Uses mergeInsert (upsert) keyed on `id` so that all updates are
     * applied in one pass — creating a single new table version instead
     * of one per row.
     *
     * Only the line metadata is changed — the vector remains untouched.
     *
     * @param updates — FileChunkRecords with updated line numbers.
     */
    async updateFileChunkLines(updates: FileChunkRecord[]): Promise<void> {
        if (updates.length === 0 || !this.fileChunksTable) {
            return;
        }
        this.ensureOpen();

        // Build raw rows matching the file_chunks table schema
        const rows = updates.map(r => ({
            id: r.id,
            filePathId: r.filePathId,
            startLine: r.startLine,
            endLine: r.endLine,
            sha256: r.sha256,
            vectorId: r.vectorId,
        }));

        await this.fileChunksTable
            .mergeInsert('id')
            .whenMatchedUpdateAll()
            .execute(rows);
    }

    /**
     * Set the source-file SHA-256 for one or more file paths.
     *
     * The sha256 column in the FilePaths table records the SHA-256 of
     * the source file that was used to produce the chunks stored in the
     * database.  A non-empty sha256 means "all chunks are valid for this
     * file version"; an empty string means "some or all chunks are invalid."
     *
     * Uses mergeInsert (upsert) keyed on `id` so that all updates are
     * applied in a single pass.
     */
    async setFileVersions(updates: { filePath: string; sha256: string }[]): Promise<void> {
        if (updates.length === 0 || !this.filePathsTable) {
            return;
        }
        this.ensureOpen();

        // Build full rows for mergeInsert (filePath is unchanged but required
        // by whenMatchedUpdateAll since it writes all columns)
        const rows: { id: number; filePath: string; sha256: string }[] = [];
        for (const u of updates) {
            const filePathId = this.filePathCache.get(u.filePath);
            if (filePathId === undefined) {
                continue;
            }
            rows.push({ id: filePathId, filePath: u.filePath, sha256: u.sha256 });
        }

        if (rows.length === 0) {
            return;
        }

        await this.filePathsTable
            .mergeInsert('id')
            .whenMatchedUpdateAll()
            .whenNotMatchedInsertAll()
            .execute(rows);

        // Update the in-memory cache
        for (const row of rows) {
            this.fileVersionCache.set(row.id, row.sha256);
        }
    }

    // ── Search ──────────────────────────────────────────────────────────────

    /**
     * Find the nearest FileChunks to a query vector.
     *
     * Performs a vector similarity search on the Vectors table, then
     * resolves the fileChunkId foreign key to return FileChunk metadata.
     *
     * @param queryVector — the embedding vector to search against.
     * @param topK — maximum number of FileChunk results to return (default 10).
     * @returns FileChunks ordered by ascending distance (_distance).
     */
    async getNearestFileChunks(
        queryVector: Float32Array,
        topK: number = 10,
    ): Promise<FileChunkSearchResult[]> {
        if (!this.vectorsTable || !this.fileChunksTable) {
            return [];
        }

        const vector = Array.from(queryVector);

        const vectorHits = await this.vectorsTable
            .vectorSearch(vector)
            .distanceType('cosine')
            .select(['id', 'fileChunkId'])
            .limit(topK)
            .toArray() as { id: number; fileChunkId: number; _distance: number }[];

        if (vectorHits.length === 0) {
            return [];
        }

        // Build a map: fileChunkId → distance
        const distanceByChunkId = new Map<number, number>();
        for (const hit of vectorHits) {
            distanceByChunkId.set(hit.fileChunkId, hit._distance);
        }

        // Fetch FileChunk rows
        const chunkIdList = Array.from(distanceByChunkId.keys()).join(', ');
        const chunkRows = await this.fileChunksTable
            .query()
            .select(['id', 'filePathId', 'startLine', 'endLine', 'sha256'])
            .where(`id IN (${chunkIdList})`)
            .toArray() as {
                id: number;
                filePathId: number;
                startLine: number;
                endLine: number;
                sha256: string;
            }[];

        // Resolve filePathIds → filePaths
        const filePathIdSet = new Set(chunkRows.map(r => r.filePathId));
        const filePathMap = await this.resolveFilePathIds(Array.from(filePathIdSet));

        // Assemble results
        const results: FileChunkSearchResult[] = chunkRows.map(row => ({
            id: row.id,
            filePath: filePathMap.get(row.filePathId) ?? '',
            startLine: row.startLine,
            endLine: row.endLine,
            sha256: row.sha256,
            _distance: distanceByChunkId.get(row.id)!,
        }));

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
     * Get all FileChunks for multiple file paths in a single query.
     *
     * This is significantly faster than calling {@link getFileChunksByFilePath}
     * in a loop because it issues a single database query with an
     * `IN (...)` clause instead of one query per file.
     *
     * @param filePaths — the file paths to look up.
     * @returns A Map from filePath → array of FileChunkRecords.
     */
    async getFileChunksForMultipleFiles(filePaths: string[]): Promise<Map<string, FileChunkRecord[]>> {
        const result = new Map<string, FileChunkRecord[]>();

        if (!this.fileChunksTable || filePaths.length === 0) {
            return result;
        }

        // Resolve filePaths to filePathIds, skipping unknown paths
        const idToPath = new Map<number, string>();
        for (const fp of filePaths) {
            const id = this.filePathCache.get(fp);
            if (id !== undefined) {
                idToPath.set(id, fp);
            }
        }

        if (idToPath.size === 0) {
            return result;
        }

        const idList = Array.from(idToPath.keys()).join(', ');
        const rows = await this.fileChunksTable
            .query()
            .select(['id', 'filePathId', 'startLine', 'endLine', 'sha256', 'vectorId'])
            .where(`filePathId IN (${idList})`)
            .toArray() as {
                id: number;
                filePathId: number;
                startLine: number;
                endLine: number;
                sha256: string;
                vectorId: number;
            }[];

        for (const row of rows) {
            const fp = idToPath.get(row.filePathId);
            if (!fp) {
                continue;
            }
            let arr = result.get(fp);
            if (!arr) {
                arr = [];
                result.set(fp, arr);
            }
            arr.push({
                id: row.id,
                filePath: fp,
                filePathId: row.filePathId,
                startLine: row.startLine,
                endLine: row.endLine,
                sha256: row.sha256,
                vectorId: row.vectorId,
            });
        }

        return result;
    }

    /**
     * Get the total number of FileChunks in the database.
     */
    async countFileChunks(): Promise<number> {
        if (!this.fileChunksTable) {
            return 0;
        }
        return this.fileChunksTable.countRows();
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
     * Optimize the database by compacting data files and cleaning up
     * old versions for all tables.
     *
     * LanceDB uses logical deletes (a deletion bitmap).  Over time,
     * compaction rewrites data files to physically remove deleted rows
     * and reclaim disk space.
     *
     * Call this during idle periods or when a user explicitly requests it.
     */
    async compact(): Promise<void> {
        this.ensureOpen();

        const tables: [string, Table | null][] = [
            [TBL_VECTORS, this.vectorsTable],
            [TBL_FILE_PATHS, this.filePathsTable],
            [TBL_FILE_CHUNKS, this.fileChunksTable],
        ];

        for (const [name, table] of tables) {
            if (!table) {
                continue;
            }
            try {
                const stats = await table.optimize();
                log(`VectorDatabase: compacted '${name}' — removed ${stats.compaction.filesRemoved} files, ${stats.prune.bytesRemoved} bytes`);
            } catch (err) {
                error(`VectorDatabase: compaction of '${name}' failed: ${err}`);
            }
        }
    }

    // ── Internals ───────────────────────────────────────────────────────────

    /**
     * Insert one or more vectors into the Vectors table.
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
            vector: Array.from(v),
            fileChunkId: fileChunkIds[i],
        }));

        if (!this.vectorsTable) {
            this.vectorsTable = await this.db!.createTable(TBL_VECTORS, rows);
            await this.createIndexSafe(this.vectorsTable, 'id');
            await this.createIndexSafe(this.vectorsTable, 'fileChunkId');
        } else {
            await this.vectorsTable.add(rows);
        }
    }

    /**
     * Ensure that each file path has an entry in the FilePaths table.
     *
     * Uses an in-memory cache to avoid redundant inserts.
     *
     * @returns The filePathIds corresponding to each input path.
     */
    private async ensureFilePaths(filePaths: string[]): Promise<number[]> {
        const newRows: { id: number; filePath: string; sha256: string }[] = [];

        const ids = filePaths.map(fp => {
            let id = this.filePathCache.get(fp);
            if (id === undefined) {
                id = this.nextFilePathId++;
                this.filePathCache.set(fp, id);
                newRows.push({ id, filePath: fp, sha256: '' });
            }
            return id;
        });

        if (newRows.length > 0) {
            if (!this.filePathsTable) {
                this.filePathsTable = await this.db!.createTable(TBL_FILE_PATHS, newRows);
                await this.createIndexSafe(this.filePathsTable, 'id');
            } else {
                await this.filePathsTable.add(newRows);
            }
        }

        return ids;
    }

    /**
     * Resolve an array of filePathIds to their filePath strings.
     *
     * @returns A Map from filePathId → filePath.
     */
    private async resolveFilePathIds(filePathIds: number[]): Promise<Map<number, string>> {
        const result = new Map<number, string>();

        // Try the in-memory cache first
        const missing: number[] = [];
        for (const id of filePathIds) {
            let found = false;
            for (const [path, cachedId] of this.filePathCache) {
                if (cachedId === id) {
                    result.set(id, path);
                    found = true;
                    break;
                }
            }
            if (!found) {
                missing.push(id);
            }
        }

        // Fall back to querying the table for any not in cache
        if (missing.length > 0 && this.filePathsTable) {
            const idList = missing.join(', ');
            const rows = await this.filePathsTable
                .query()
                .select(['id', 'filePath'])
                .where(`id IN (${idList})`)
                .toArray() as { id: number; filePath: string }[];
            for (const row of rows) {
                result.set(row.id, row.filePath);
                this.filePathCache.set(row.filePath, row.id);
            }
        }

        return result;
    }

    /**
     * Assert that the database connection is open.
     */
    private ensureOpen(): void {
        if (!this.db) {
            throw new Error('VectorDatabase: database is not open — call open() first');
        }
    }

    /**
     * Ensure scalar BTree indexes exist on all key filter columns.
     *
     * Uses `replace: false` so that existing indexes are left untouched
     * (this is a no-op for columns that are already indexed).  Only the
     * tables that are currently open are indexed — tables created lazily
     * during insert will be indexed at creation time.
     *
     * Indexes are persisted on disk by LanceDB and survive across
     * open/close cycles, so this only does real work on first run or
     * after a database is created from scratch.
     */
    private async ensureScalarIndexes(): Promise<void> {
        const t0 = Date.now();
        let count = 0;

        // file_chunks: filtered by id (deletes) and filePathId (lookups)
        if (this.fileChunksTable) {
            count += await this.createIndexSafe(this.fileChunksTable, 'id');
            count += await this.createIndexSafe(this.fileChunksTable, 'filePathId');
        }

        // vectors: filtered by id (deletes) and fileChunkId (search resolution)
        if (this.vectorsTable) {
            count += await this.createIndexSafe(this.vectorsTable, 'id');
            count += await this.createIndexSafe(this.vectorsTable, 'fileChunkId');
        }

        // file_paths: filtered by id (deletes, lookups)
        if (this.filePathsTable) {
            count += await this.createIndexSafe(this.filePathsTable, 'id');
        }

        if (count > 0) {
            log(`VectorDatabase: created ${count} scalar index(es) in ${Date.now() - t0}ms`);
        }
    }

    /**
     * Create a scalar BTree index on a column, ignoring errors if the
     * index already exists or the table is empty.
     *
     * @returns 1 if the index was created, 0 if it already existed or
     *          could not be created.
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
     * Load persisted metadata from the JSON file.
     *
     * The file is deleted immediately after a successful read so that a
     * crash while the database is open guarantees the file will not be
     * present on the next startup — forcing a full table-scan recovery.
     * The file is only recreated during {@link close}.
     *
     * @returns The parsed metadata, or `null` if the file does not exist
     *          or is corrupt.
     */
    private async loadMeta(): Promise<DatabaseMeta | null> {
        const metaPath = path.join(this.dbPath, META_FILE);
        try {
            const raw = await fs.promises.readFile(metaPath, 'utf-8');

            // Delete immediately — if we crash before close(), the file
            // won't exist on next startup and we'll recover from tables.
            // This should avoid stale metadata after a crash
            // (e.g. nextVectorId too low, causing ID collisions).
            await fs.promises.unlink(metaPath);

            const meta = JSON.parse(raw) as DatabaseMeta;
            if (
                typeof meta.nextVectorId === 'number' &&
                typeof meta.nextFilePathId === 'number' &&
                typeof meta.nextFileChunkId === 'number'
            ) {
                return meta;
            }
            warn('VectorDatabase: meta.json has invalid shape — will recover from tables');
            return null;
        } catch {
            // File doesn't exist or can't be read — that's fine
            return null;
        }
    }

    /**
     * Persist current auto-increment counters to the metadata JSON file.
     */
    private async saveMeta(): Promise<void> {
        const metaPath = path.join(this.dbPath, META_FILE);
        const meta: DatabaseMeta = {
            nextVectorId: this.nextVectorId,
            nextFilePathId: this.nextFilePathId,
            nextFileChunkId: this.nextFileChunkId,
        };
        try {
            await fs.promises.writeFile(metaPath, JSON.stringify(meta), 'utf-8');
        } catch (err) {
            error(`VectorDatabase: failed to write meta.json: ${err}`);
        }
    }

    /**
     * Recover the next auto-increment id from an existing table.
     *
     * This is a fallback used only when meta.json is missing or corrupt
     * (e.g. after a crash).  Fetches only the lightweight id column
     * (vectors are excluded by the select projection).  LanceDB does
     * not expose ORDER BY or aggregate functions, so we must scan all
     * ids to find the max.
     */
    private async recoverNextId(table: Table, column: string): Promise<number> {
        const count = await table.countRows();
        if (count === 0) {
            return 1;
        }
        const rows = await table
            .query()
            .select([column])
            .toArray();
        let maxId = 0;
        for (const row of rows) {
            const val = (row as Record<string, number>)[column];
            if (val > maxId) {
                maxId = val;
            }
        }
        return maxId + 1;
    }

    /**
     * Scan all tables for referential integrity violations and optionally
     * delete orphaned rows.
     *
     * Detects:
     *   1. Orphaned vectors    — Vectors whose fileChunkId no longer
     *                            exists in FileChunks.
     *   2. Orphaned file paths — FilePaths that no FileChunk references.
     *   3. Dangling chunks     — FileChunks whose vectorId no longer
     *                            exists in Vectors.
     *
     * The check only reads lightweight id/FK columns — no vector data is
     * loaded — so the cost is proportional to the row count, not the
     * embedding dimension.
     *
     * @param repair — when `true`, delete every orphaned row that is found.
     * @returns Summary counts of the violations detected (before repair).
     */
    private async checkIntegrity(repair: boolean = false): Promise<{
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

        // ── Collect id sets from each table ─────────────────────────────

        const vectorIds = new Set<number>();
        const vectorFileChunkIds = new Set<number>();
        if (this.vectorsTable) {
            const rows = await this.vectorsTable
                .query()
                .select(['id', 'fileChunkId'])
                .toArray() as { id: number; fileChunkId: number }[];
            for (const r of rows) {
                vectorIds.add(r.id);
                vectorFileChunkIds.add(r.fileChunkId);
            }
        }

        const fileChunkIds = new Set<number>();
        const fileChunkVectorIds = new Set<number>();
        const fileChunkFilePathIds = new Set<number>();
        if (this.fileChunksTable) {
            const rows = await this.fileChunksTable
                .query()
                .select(['id', 'vectorId', 'filePathId'])
                .toArray() as { id: number; vectorId: number; filePathId: number }[];
            for (const r of rows) {
                fileChunkIds.add(r.id);
                fileChunkVectorIds.add(r.vectorId);
                fileChunkFilePathIds.add(r.filePathId);
            }
        }

        const filePathIds = new Set<number>();
        if (this.filePathsTable) {
            const rows = await this.filePathsTable
                .query()
                .select(['id'])
                .toArray() as { id: number }[];
            for (const r of rows) {
                filePathIds.add(r.id);
            }
        }

        // ── 1. Orphaned vectors — fileChunkId not in FileChunks ──────────
        const orphanedVectorIds: number[] = [];
        for (const fcId of vectorFileChunkIds) {
            if (!fileChunkIds.has(fcId)) {
                // Find all vector ids that reference this missing fileChunkId
                // (already collected above, but we need the vector id)
            }
        }
        // Re-scan to collect actual vector ids whose fileChunkId is missing
        if (this.vectorsTable) {
            const rows = await this.vectorsTable
                .query()
                .select(['id', 'fileChunkId'])
                .toArray() as { id: number; fileChunkId: number }[];
            for (const r of rows) {
                if (!fileChunkIds.has(r.fileChunkId)) {
                    orphanedVectorIds.push(r.id);
                }
            }
        }
        result.orphanedVectors = orphanedVectorIds.length;

        // ── 2. Orphaned file paths — no FileChunk references them ────────
        const orphanedFilePathIds: number[] = [];
        for (const id of filePathIds) {
            if (!fileChunkFilePathIds.has(id)) {
                orphanedFilePathIds.push(id);
            }
        }
        result.orphanedFilePaths = orphanedFilePathIds.length;

        // ── 3. Dangling file chunks — vectorId not in Vectors ────────────
        const danglingChunkVectorIds: number[] = [];
        for (const vid of fileChunkVectorIds) {
            if (!vectorIds.has(vid)) {
                danglingChunkVectorIds.push(vid);
            }
        }
        result.danglingFileChunks = danglingChunkVectorIds.length;

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

        // Delete orphaned vectors
        if (this.vectorsTable && orphanedVectorIds.length > 0) {
            const idList = orphanedVectorIds.join(', ');
            await this.vectorsTable.delete(`id IN (${idList})`);
        }

        // Delete orphaned file paths
        if (this.filePathsTable && orphanedFilePathIds.length > 0) {
            const idList = orphanedFilePathIds.join(', ');
            await this.filePathsTable.delete(`id IN (${idList})`);
            // Also evict from the in-memory caches
            for (const [fp, fpId] of this.filePathCache) {
                if (orphanedFilePathIds.includes(fpId)) {
                    this.filePathCache.delete(fp);
                    this.fileVersionCache.delete(fpId);
                }
            }
        }

        // Delete dangling file chunks (those whose vectorId is missing)
        if (danglingChunkVectorIds.length > 0 && this.fileChunksTable) {
            const rows = await this.fileChunksTable
                .query()
                .select(['id', 'vectorId'])
                .toArray() as { id: number; vectorId: number }[];
            const danglingVectorIdSet = new Set(danglingChunkVectorIds);
            const chunkIdsToDelete = rows
                .filter(r => danglingVectorIdSet.has(r.vectorId))
                .map(r => r.id);
            if (chunkIdsToDelete.length > 0) {
                await this.deleteFileChunks(chunkIdsToDelete);
            }
        }

        log(`VectorDatabase: integrity repair complete — removed ${total} orphan(s)`);
        return result;
    }
}
