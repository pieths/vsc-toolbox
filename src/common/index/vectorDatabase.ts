// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * VectorDatabase — a wrapper around a LanceDB database instance.
 *
 * Uses a normalized multi-table schema so that vector similarity search
 * can resolve results back to file-backed chunks (and shadow chunks that
 * act as extra search context).
 *
 * Tables:
 *
 *   Vectors       — id, vector (float32[], fixed dimension)
 *   FilePaths     — id, filePath
 *   FileChunks    — id, filePathId, startLine, endLine, sha256, vectorId
 *   Links         — vectorId, fileChunkId  (maps vector → FileChunk)
 *   ShadowChunks  — text, vectorId, fileChunkId
 *
 * The Links table is the join point used after a vector search: every
 * vector that appears in the Vectors table has at least one row in Links
 * pointing to the FileChunk it is associated with.  FileChunks own
 * their embedding vector directly (vectorId), while ShadowChunks provide
 * additional embedded text that also links back to a FileChunk via Links.
 *
 * LanceDB stores data in the Lance columnar format on disk and memory-maps
 * it at query time.  Vectors never enter the V8 heap, so this works within
 * the Electron extension host memory limits.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Connection, Table } from '@lancedb/lancedb';
import { log, warn, error } from '../logger';

// ── Public types ────────────────────────────────────────────────────────────

/** A FileChunk record as stored in the database (foreign keys resolved). */
export interface FileChunkRecord {
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

/** Input data for inserting a ShadowChunk. */
export interface ShadowChunkInput {
    /** The text content of the shadow chunk */
    text: string;
    /** Embedding vector for the text */
    vector: Float32Array;
    /** The id of the FileChunk this shadow chunk corresponds to */
    fileChunkId: number;
}

/** A ShadowChunk record as stored in the database. */
export interface ShadowChunkRecord {
    /** The text content of the shadow chunk */
    text: string;
    /** The id of the FileChunk this shadow chunk corresponds to */
    fileChunkId: number;
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
const TBL_LINKS = 'links';
const TBL_SHADOW_CHUNKS = 'shadow_chunks';

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
    private linksTable: Table | null = null;
    private shadowChunksTable: Table | null = null;

    private nextVectorId: number = 1;
    private nextFilePathId: number = 1;
    private nextFileChunkId: number = 1;

    /** In-memory cache mapping filePath → filePathId for fast lookups. */
    private filePathCache = new Map<string, number>();

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
            // Populate the in-memory cache
            const fpRows = await this.filePathsTable
                .query()
                .select(['id', 'filePath'])
                .toArray() as { id: number; filePath: string }[];
            for (const row of fpRows) {
                this.filePathCache.set(row.filePath, row.id);
            }
        }

        // ── FileChunks ──────────────────────────────────────────────────
        if (tableNames.includes(TBL_FILE_CHUNKS)) {
            this.fileChunksTable = await this.db.openTable(TBL_FILE_CHUNKS);
            if (!meta) {
                this.nextFileChunkId = await this.recoverNextId(this.fileChunksTable, 'id');
            }
        }

        // ── Links ───────────────────────────────────────────────────────
        if (tableNames.includes(TBL_LINKS)) {
            this.linksTable = await this.db.openTable(TBL_LINKS);
        }

        // ── ShadowChunks ────────────────────────────────────────────────
        if (tableNames.includes(TBL_SHADOW_CHUNKS)) {
            this.shadowChunksTable = await this.db.openTable(TBL_SHADOW_CHUNKS);
        }

        if (meta) {
            this.nextVectorId = meta.nextVectorId;
            this.nextFilePathId = meta.nextFilePathId;
            this.nextFileChunkId = meta.nextFileChunkId;
            log('VectorDatabase: opened (ids restored from metadata)');
        } else {
            log('VectorDatabase: opened (ids recovered from table scan)');
        }
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
            this.linksTable,
            this.shadowChunksTable,
        ];
        for (const t of tables) {
            t?.close();
        }
        this.vectorsTable = null;
        this.filePathsTable = null;
        this.fileChunksTable = null;
        this.linksTable = null;
        this.shadowChunksTable = null;

        this.db?.close();
        this.db = null;

        this.filePathCache.clear();
    }

    // ── Insert ──────────────────────────────────────────────────────────────

    /**
     * Add a single FileChunk to the database.
     *
     * Creates a vector, a FilePath (if needed), a FileChunk, and a Link.
     *
     * @returns The assigned FileChunk id.
     */
    async addFileChunk(chunk: FileChunkInput): Promise<number> {
        const ids = await this.addFileChunks([chunk]);
        return ids[0];
    }

    /**
     * Add multiple FileChunks to the database in a single batch.
     *
     * For each chunk this method will:
     *   1. Insert the embedding vector into Vectors → vectorId
     *   2. Ensure the filePath exists in FilePaths → filePathId
     *   3. Insert the FileChunk → fileChunkId
     *   4. Insert a Link (vectorId → fileChunkId)
     *
     * @returns An array of the assigned FileChunk ids (in insertion order).
     */
    async addFileChunks(chunks: FileChunkInput[]): Promise<number[]> {
        if (chunks.length === 0) {
            return [];
        }

        this.ensureOpen();

        // 1. Insert vectors
        const vectorIds = await this.insertVectors(chunks.map(c => c.vector));

        // 2. Ensure file paths exist
        const filePathIds = await this.ensureFilePaths(chunks.map(c => c.filePath));

        // 3. Insert FileChunks
        const fileChunkIds: number[] = [];
        const fileChunkRows = chunks.map((chunk, i) => {
            const id = this.nextFileChunkId++;
            fileChunkIds.push(id);
            return {
                id,
                filePathId: filePathIds[i],
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                sha256: chunk.sha256,
                vectorId: vectorIds[i],
            };
        });

        if (!this.fileChunksTable) {
            this.fileChunksTable = await this.db!.createTable(TBL_FILE_CHUNKS, fileChunkRows);
        } else {
            await this.fileChunksTable.add(fileChunkRows);
        }

        // 4. Insert Links (vector → fileChunk)
        const linkRows = vectorIds.map((vectorId, i) => ({
            vectorId,
            fileChunkId: fileChunkIds[i],
        }));

        if (!this.linksTable) {
            this.linksTable = await this.db!.createTable(TBL_LINKS, linkRows);
        } else {
            await this.linksTable.add(linkRows);
        }

        log(`VectorDatabase: added ${chunks.length} file chunk(s)`);
        return fileChunkIds;
    }

    /**
     * Add a single ShadowChunk to the database.
     *
     * A shadow chunk contains text that is embedded and linked to an
     * existing FileChunk. This provides additional search context that
     * helps vector search point to the correct file location.
     *
     * Creates a vector, a ShadowChunk row, and a Link.
     */
    async addShadowChunk(shadow: ShadowChunkInput): Promise<void> {
        await this.addShadowChunks([shadow]);
    }

    /**
     * Add multiple ShadowChunks to the database in a single batch.
     */
    async addShadowChunks(shadows: ShadowChunkInput[]): Promise<void> {
        if (shadows.length === 0) {
            return;
        }

        this.ensureOpen();

        // 1. Insert vectors
        const vectorIds = await this.insertVectors(shadows.map(s => s.vector));

        // 2. Insert ShadowChunks
        const shadowRows = shadows.map((s, i) => ({
            text: s.text,
            vectorId: vectorIds[i],
            fileChunkId: s.fileChunkId,
        }));

        if (!this.shadowChunksTable) {
            this.shadowChunksTable = await this.db!.createTable(TBL_SHADOW_CHUNKS, shadowRows);
        } else {
            await this.shadowChunksTable.add(shadowRows);
        }

        // 3. Insert Links (vector → fileChunk)
        const linkRows = shadows.map((s, i) => ({
            vectorId: vectorIds[i],
            fileChunkId: s.fileChunkId,
        }));

        if (!this.linksTable) {
            this.linksTable = await this.db!.createTable(TBL_LINKS, linkRows);
        } else {
            await this.linksTable.add(linkRows);
        }

        log(`VectorDatabase: added ${shadows.length} shadow chunk(s)`);
    }

    // ── Delete ──────────────────────────────────────────────────────────────

    /**
     * Delete everything associated with a file path: all FileChunks,
     * their vectors, links, shadow chunks, and the FilePath entry itself.
     *
     * After this call the file path will no longer exist in the database
     * or in the in-memory cache.
     */
    async deleteByFilePath(filePath: string): Promise<void> {
        if (!this.fileChunksTable || !this.filePathsTable) {
            return;
        }

        const filePathId = this.filePathCache.get(filePath);
        if (filePathId === undefined) {
            return;
        }

        // Find all FileChunk ids for this file
        const chunkRows = await this.fileChunksTable
            .query()
            .select(['id'])
            .where(`filePathId = ${filePathId}`)
            .toArray() as { id: number }[];

        // Delete all chunks (and their vectors, links, shadow chunks)
        if (chunkRows.length > 0) {
            await this.deleteFileChunks(chunkRows.map(r => r.id));
        }

        // Delete the FilePath entry itself
        await this.filePathsTable.delete(`id = ${filePathId}`);
        this.filePathCache.delete(filePath);
    }

    /**
     * Delete a single FileChunk by its id.
     *
     * Also removes the associated vector, link(s), and any shadow chunks
     * that reference this FileChunk.
     */
    async deleteFileChunkById(fileChunkId: number): Promise<void> {
        await this.deleteFileChunks([fileChunkId]);
    }

    /**
     * Delete all FileChunks (and their vectors, links, and shadow chunks)
     * associated with a specific file path.
     */
    async deleteFileChunksByFilePath(filePath: string): Promise<void> {
        if (!this.fileChunksTable || !this.filePathsTable) {
            return;
        }

        const filePathId = this.filePathCache.get(filePath);
        if (filePathId === undefined) {
            return;
        }

        // Find all FileChunk ids for this file
        const chunkRows = await this.fileChunksTable
            .query()
            .select(['id'])
            .where(`filePathId = ${filePathId}`)
            .toArray() as { id: number }[];

        if (chunkRows.length === 0) {
            return;
        }

        await this.deleteFileChunks(chunkRows.map(r => r.id));
    }

    /**
     * Delete a FileChunk identified by file path + line range.
     *
     * Also removes the associated vector, link(s), and any shadow chunks.
     */
    async deleteFileChunkByLocation(filePath: string, startLine: number, endLine: number): Promise<void> {
        if (!this.fileChunksTable) {
            return;
        }

        const filePathId = this.filePathCache.get(filePath);
        if (filePathId === undefined) {
            return;
        }

        const chunkRows = await this.fileChunksTable
            .query()
            .select(['id'])
            .where(`filePathId = ${filePathId} AND startLine = ${startLine} AND endLine = ${endLine}`)
            .toArray() as { id: number }[];

        if (chunkRows.length === 0) {
            return;
        }

        await this.deleteFileChunks(chunkRows.map(r => r.id));
    }

    /**
     * Delete multiple FileChunks by their ids in a single pass.
     *
     * Also removes associated vectors, links, and shadow chunks.
     */
    async deleteFileChunks(fileChunkIds: number[]): Promise<void> {
        if (fileChunkIds.length === 0) {
            return;
        }
        this.ensureOpen();

        const idList = fileChunkIds.join(', ');

        // Collect vectorIds to delete (from FileChunks + ShadowChunks)
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
        }

        if (this.shadowChunksTable) {
            const shadowRows = await this.shadowChunksTable
                .query()
                .select(['vectorId'])
                .where(`fileChunkId IN (${idList})`)
                .toArray() as { vectorId: number }[];
            for (const r of shadowRows) {
                vectorIdsToDelete.add(r.vectorId);
            }

            // Delete shadow chunks
            await this.shadowChunksTable.delete(`fileChunkId IN (${idList})`);
        }

        // Delete links
        if (this.linksTable) {
            await this.linksTable.delete(`fileChunkId IN (${idList})`);
        }

        // Delete file chunks
        if (this.fileChunksTable) {
            await this.fileChunksTable.delete(`id IN (${idList})`);
        }

        // Delete vectors
        if (this.vectorsTable && vectorIdsToDelete.size > 0) {
            const vecIdList = Array.from(vectorIdsToDelete).join(', ');
            await this.vectorsTable.delete(`id IN (${vecIdList})`);
        }
    }

    // ── Search ──────────────────────────────────────────────────────────────

    /**
     * Find the nearest FileChunks to a query vector.
     *
     * Performs a vector similarity search on the Vectors table, then
     * resolves through the Links table to return deduplicated FileChunk
     * results. Both direct chunk vectors and shadow chunk vectors
     * participate in the search.
     *
     * @param queryVector — the embedding vector to search against.
     * @param topK — maximum number of FileChunk results to return (default 10).
     * @returns FileChunks ordered by ascending distance (_distance).
     */
    async getNearestFileChunks(
        queryVector: Float32Array,
        topK: number = 10,
    ): Promise<FileChunkSearchResult[]> {
        if (!this.vectorsTable || !this.linksTable || !this.fileChunksTable) {
            return [];
        }

        const vector = Array.from(queryVector);

        // Search for more vectors than topK since multiple vectors can
        // map to the same FileChunk (via shadow chunks)
        const searchLimit = topK * 3;
        const vectorHits = await this.vectorsTable
            .vectorSearch(vector)
            .distanceType('cosine')
            .select(['id'])
            .limit(searchLimit)
            .toArray() as { id: number; _distance: number }[];

        if (vectorHits.length === 0) {
            return [];
        }

        // Resolve vectorIds → fileChunkIds via Links
        const vectorIdList = vectorHits.map(v => v.id).join(', ');
        const linkRows = await this.linksTable
            .query()
            .select(['vectorId', 'fileChunkId'])
            .where(`vectorId IN (${vectorIdList})`)
            .toArray() as { vectorId: number; fileChunkId: number }[];

        // Build a map: fileChunkId → best (lowest) distance
        const distanceByVectorId = new Map<number, number>();
        for (const hit of vectorHits) {
            distanceByVectorId.set(hit.id, hit._distance);
        }

        const bestDistanceByChunkId = new Map<number, number>();
        for (const link of linkRows) {
            const dist = distanceByVectorId.get(link.vectorId);
            if (dist === undefined) {
                continue;
            }
            const current = bestDistanceByChunkId.get(link.fileChunkId);
            if (current === undefined || dist < current) {
                bestDistanceByChunkId.set(link.fileChunkId, dist);
            }
        }

        if (bestDistanceByChunkId.size === 0) {
            return [];
        }

        // Fetch FileChunk rows
        const chunkIdList = Array.from(bestDistanceByChunkId.keys()).join(', ');
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
            _distance: bestDistanceByChunkId.get(row.id)!,
        }));

        // Sort by distance ascending, then take topK
        results.sort((a, b) => a._distance - b._distance);
        return results.slice(0, topK);
    }

    // ── Query ───────────────────────────────────────────────────────────────

    /**
     * Get all FileChunks associated with a given file path.
     */
    async getFileChunksByFilePath(filePath: string): Promise<FileChunkRecord[]> {
        if (!this.fileChunksTable) {
            return [];
        }

        const filePathId = this.filePathCache.get(filePath);
        if (filePathId === undefined) {
            return [];
        }

        const rows = await this.fileChunksTable
            .query()
            .select(['id', 'filePathId', 'startLine', 'endLine', 'sha256'])
            .where(`filePathId = ${filePathId}`)
            .toArray() as {
                id: number;
                filePathId: number;
                startLine: number;
                endLine: number;
                sha256: string;
            }[];

        return rows.map(row => ({
            id: row.id,
            filePath,
            startLine: row.startLine,
            endLine: row.endLine,
            sha256: row.sha256,
        }));
    }

    /**
     * Get all ShadowChunks associated with a given FileChunk id.
     */
    async getShadowChunksByFileChunkId(fileChunkId: number): Promise<ShadowChunkRecord[]> {
        if (!this.shadowChunksTable) {
            return [];
        }

        const rows = await this.shadowChunksTable
            .query()
            .select(['text', 'fileChunkId'])
            .where(`fileChunkId = ${fileChunkId}`)
            .toArray() as ShadowChunkRecord[];

        return rows;
    }

    /**
     * Get FileChunks by an array of SHA-256 hashes.
     */
    async getFileChunksBySha256(hashes: string[]): Promise<FileChunkRecord[]> {
        if (!this.fileChunksTable || hashes.length === 0) {
            return [];
        }

        const escaped = hashes.map(h => `'${this.escapeSql(h)}'`).join(', ');
        const rows = await this.fileChunksTable
            .query()
            .select(['id', 'filePathId', 'startLine', 'endLine', 'sha256'])
            .where(`sha256 IN (${escaped})`)
            .toArray() as {
                id: number;
                filePathId: number;
                startLine: number;
                endLine: number;
                sha256: string;
            }[];

        // Resolve file paths
        const filePathIdSet = new Set(rows.map(r => r.filePathId));
        const filePathMap = await this.resolveFilePathIds(Array.from(filePathIdSet));

        return rows.map(row => ({
            id: row.id,
            filePath: filePathMap.get(row.filePathId) ?? '',
            startLine: row.startLine,
            endLine: row.endLine,
            sha256: row.sha256,
        }));
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
     * Get the total number of ShadowChunks in the database.
     */
    async countShadowChunks(): Promise<number> {
        if (!this.shadowChunksTable) {
            return 0;
        }
        return this.shadowChunksTable.countRows();
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
            [TBL_LINKS, this.linksTable],
            [TBL_SHADOW_CHUNKS, this.shadowChunksTable],
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
     * @returns The assigned vector ids (in insertion order).
     */
    private async insertVectors(vectors: Float32Array[]): Promise<number[]> {
        const ids: number[] = [];
        const rows = vectors.map(v => {
            const id = this.nextVectorId++;
            ids.push(id);
            return { id, vector: Array.from(v) };
        });

        if (!this.vectorsTable) {
            this.vectorsTable = await this.db!.createTable(TBL_VECTORS, rows);
        } else {
            await this.vectorsTable.add(rows);
        }

        return ids;
    }

    /**
     * Ensure that each file path has an entry in the FilePaths table.
     *
     * Uses an in-memory cache to avoid redundant inserts.
     *
     * @returns The filePathIds corresponding to each input path.
     */
    private async ensureFilePaths(filePaths: string[]): Promise<number[]> {
        const newRows: { id: number; filePath: string }[] = [];

        const ids = filePaths.map(fp => {
            let id = this.filePathCache.get(fp);
            if (id === undefined) {
                id = this.nextFilePathId++;
                this.filePathCache.set(fp, id);
                newRows.push({ id, filePath: fp });
            }
            return id;
        });

        if (newRows.length > 0) {
            if (!this.filePathsTable) {
                this.filePathsTable = await this.db!.createTable(TBL_FILE_PATHS, newRows);
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
     * Escape single quotes in SQL string literals to prevent injection.
     */
    private escapeSql(value: string): string {
        return value.replace(/'/g, "''");
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
}
