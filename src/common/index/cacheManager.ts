// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import picomatch from 'picomatch';
import { FileIndex } from './fileIndex';
import { ThreadPool } from './workers/threadPool';
import { IndexInput, IndexStatus, NearestEmbeddingResult } from './types';
import { LlamaServer } from './embeddings/llamaServer';
import { VectorDatabase } from './embeddings/vectorDatabase';
import { EmbeddingProcessor } from './embeddings/embeddingProcessor';
import { PathFilter } from './pathFilter';
import { log, warn, error } from '../logger';

/** Mutation queue entry — ordered for temporal "last action wins" collapse. */
interface FileMutationEntry {
    action: 'dirty' | 'delete';
    filePath: string;
}

/** Pending vector search query, resolved by the drain loop. */
interface VectorQueryEntry {
    vector: Float32Array;
    topK: number;
    resolve: (value: NearestEmbeddingResult[]) => void;
    reject: (reason: unknown) => void;
}

/**
 * CacheManager manages the collection of FileIndex instances and coordinates
 * cache operations across all indexed files.
 *
 * All indexing and embedding work is driven by a single serial drain loop
 * that consumes from an ordered {@link fileMutationQueue}. This eliminates
 * race conditions from overlapping `indexAll()` calls and ensures queries
 * always see a consistent, quiescent database snapshot.
 */
export class CacheManager {
    private cache: Map<string, FileIndex> = new Map();
    private indexingComplete: boolean = false;
    private indexingPromise: Promise<void> | null = null;
    private pathFilter: PathFilter | null = null;
    private cacheDir: string = '';
    private symbolsCacheDir: string = '';
    private threadPool: ThreadPool | null = null;
    private llamaServer: LlamaServer | null = null;
    private vectorDatabase: VectorDatabase | null = null;
    private embeddingProcessor: EmbeddingProcessor | null = null;

    // ── Dirty-set drain loop state ──────────────────────────────────────────
    private fileMutationQueue: FileMutationEntry[] = [];
    private vectorQueryQueue: VectorQueryEntry[] = [];
    private drainLoopRunning = false;
    private drainLoopPromise: Promise<void> | null = null;

    /**
     * Normalize a file path for use as a cache key.
     * Converts to lowercase to handle Windows case-insensitive paths consistently.
     * This ensures paths from fs.readdir (original casing) match paths from
     * FileSystemWatcher events (lowercase drive letter on Windows).
     */
    private normalizePath(filePath: string): string {
        return filePath.toLowerCase();
    }

    /**
     * Initialize cache for all matching files in workspace.
     * Runs in background, non-blocking.
     *
     * @param pathFilter - PathFilter instance for include/exclude logic
     * @param threadPool - Thread pool manager for indexing operations
     * @param llamaServer - Llama server instance for computing embeddings
     * @param enableEmbeddings - If true, create vector database and embedding processor
     */
    async initialize(
        pathFilter: PathFilter,
        threadPool: ThreadPool,
        llamaServer: LlamaServer,
        enableEmbeddings: boolean = false
    ): Promise<void> {
        this.pathFilter = pathFilter;
        this.threadPool = threadPool;
        this.llamaServer = llamaServer;
        this.indexingComplete = false;

        // Compute cache directory once from first workspace folder
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        this.cacheDir = workspaceFolder
            ? path.join(workspaceFolder.uri.fsPath, '.cache', 'vsctoolbox', 'index')
            : '';

        // Open (or create) the vector database and embedding processor
        if (enableEmbeddings && this.cacheDir) {
            const dbPath = path.join(this.cacheDir, 'vectordb');
            this.vectorDatabase = new VectorDatabase(dbPath, this.llamaServer.getDimensions());
            await this.vectorDatabase.open();
            log(`Content index: VectorDatabase opened at ${dbPath}`);

            this.embeddingProcessor = new EmbeddingProcessor(
                this.vectorDatabase,
                this.llamaServer,
                this.threadPool,
            );
        }

        // Ensure symbols cache directory and a-z subdirectories exist
        this.symbolsCacheDir = this.cacheDir ? path.join(this.cacheDir, 'symbols') : '';
        if (this.symbolsCacheDir) {
            const alphabet = 'abcdefghijklmnopqrstuvwxyz';
            // Create a subdirectory for each letter plus '_' for non-alpha filenames
            const subdirs = [...alphabet, '_'].map(ch => path.join(this.symbolsCacheDir, ch));
            await Promise.all(subdirs.map(dir => fs.promises.mkdir(dir, { recursive: true })));
        }

        log(`Content index: includePaths =\n${JSON.stringify(pathFilter.getIncludePaths(), null, 2)}`);
        log(`Content index: fileExtensions =\n${JSON.stringify(pathFilter.getFileExtensions(), null, 2)}`);
        log(`Content index: cacheDir = ${this.cacheDir}`);

        this.indexingPromise = this.buildInitialIndex();
        await this.indexingPromise;
    }

    /**
     * Build the initial cache by discovering all matching files.
     */
    private async buildInitialIndex(): Promise<void> {
        try {
            const filePaths: string[] = [];
            // Scan each includePath directory for matching files
            for (const includePath of this.pathFilter!.getIncludePaths()) {
                try {
                    const files = await this.findFilesInDirectory(includePath);
                    // Use concat instead of spread to avoid
                    // stack overflow with large arrays
                    for (const file of files) {
                        filePaths.push(file);
                    }
                    log(`Content index: Found ${files.length} files in ${includePath}`);
                } catch (err) {
                    warn(`Content index: Failed to scan directory ${includePath}: ${err}`);
                }
            }

            log(`Content index: Found ${filePaths.length} files...`);

            // Create FileIndex instances for each file
            for (const filePath of filePaths) {
                const key = this.normalizePath(filePath);
                if (this.cache.has(key)) {
                    log(`Content index: Duplicate path: "${filePath}" (existing: "${this.cache.get(key)!.getFilePath()}")`);
                    continue;
                }
                const fileIndex = new FileIndex(filePath, this.symbolsCacheDir);
                this.cache.set(key, fileIndex);
            }

            // Push all discovered files to the mutation queue for the drain loop.
            // Assume everthing might be dirty. The worker threads will skip
            // indexing if it's not needed.
            for (const [_key, fileIndex] of this.cache) {
                this.fileMutationQueue.push({ action: 'dirty', filePath: fileIndex.getFilePath() });
            }

            // Drain all mutations — blocks until the
            // inner drain loop fully converges
            await this.awaitDrainLoop();

            this.indexingComplete = true;
            log(`Content index: Added ${this.cache.size} files to cache`);
        } catch (err) {
            error(`Content index: Failed to initialize cache: ${err}`);
            this.indexingComplete = true; // Mark complete even on error to unblock searches
        }
    }

    /**
     * Recursively find all files with matching extensions in a directory.
     *
     * @param dirPath - Directory path to scan
     * @returns Array of absolute file paths
     */
    private async findFilesInDirectory(dirPath: string): Promise<string[]> {
        const results: string[] = [];

        // Check if directory exists
        try {
            const stats = await fs.promises.stat(dirPath);
            if (!stats.isDirectory()) {
                warn(`Content index: ${dirPath} is not a directory`);
                return results;
            }
        } catch {
            warn(`Content index: Directory does not exist: ${dirPath}`);
            return results;
        }

        // Use recursive readdir (Node.js 18.17+)
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true, recursive: true });

        for (const entry of entries) {
            if (entry.isFile()) {
                // entry.parentPath is available in Node 18.17+ with recursive option
                const fullPath = path.join(entry.parentPath || dirPath, entry.name);
                if (this.pathFilter!.shouldIncludeFile(fullPath)) {
                    results.push(fullPath);
                }
            }
        }

        return results;
    }

    /**
     * Check if initial indexing is complete.
     */
    isReady(): boolean {
        return this.indexingComplete;
    }

    /**
     * Get the number of files in the cache.
     */
    getFileCount(): number {
        return this.cache.size;
    }

    /**
     * Wait for indexing to complete.
     */
    async waitUntilReady(): Promise<void> {
        if (this.indexingPromise) {
            await this.indexingPromise;
        }
    }

    /**
     * Get FileIndex instances for multiple paths.
     *
     * @param filePaths - Array of absolute file paths
     * @param ensureValid - If true, indexes any files that don't have valid tags
     * @returns Map of file path to FileIndex (only includes paths that are in cache)
     */
    async get(filePaths: string[], ensureValid: boolean = false): Promise<Map<string, FileIndex>> {
        const result = new Map<string, FileIndex>();

        for (const filePath of filePaths) {
            const fileIndex = this.cache.get(this.normalizePath(filePath));
            if (fileIndex) {
                result.set(filePath, fileIndex);
                if (ensureValid) {
                    this.fileMutationQueue.push({ action: 'dirty', filePath });
                }
            }
        }

        // Workers sha256-skip unchanged files, so unconditionally
        // draining is safe — just slightly more worker I/O.
        if (ensureValid && result.size > 0) {
            await this.awaitDrainLoop();
        }

        return result;
    }

    /**
     * Index a batch of files via worker threads and compute
     * embeddings for files that were actually re-indexed.
     *
     * @param fileIndexes - Array of FileIndex instances to index
     */
    private async indexFiles(fileIndexes: FileIndex[]): Promise<void> {
        if (!this.threadPool) {
            warn('Content index: Cannot index - thread pool not set');
            return;
        }

        const inputs: IndexInput[] = fileIndexes.map(fi => ({
            type: 'index' as const,
            filePath: fi.getFilePath(),
            idxPath: fi.getIdxPath()
        }));

        const startTime = Date.now();
        const outputs = await this.threadPool.indexAll(inputs);

        // Only compute embeddings for files that were actually re-indexed
        const indexed = outputs.filter(o => o.status === IndexStatus.Indexed);
        if (indexed.length > 0) {
            const indexedPaths = new Set(indexed.map(o => this.normalizePath(o.filePath)));
            const updatedFileIndexes = fileIndexes.filter(fi =>
                indexedPaths.has(this.normalizePath(fi.getFilePath())));
            await this.computeEmbeddings(updatedFileIndexes);
        }

        const elapsed = Date.now() - startTime;
        const skippedCount = outputs.filter(o => o.status === IndexStatus.Skipped).length;
        if (indexed.length > 0 || skippedCount > 0) {
            log(`Content index: Indexed ${indexed.length} files (${skippedCount} skipped) in ${elapsed}ms`);
        }
    }

    /**
     * Compute embeddings for the given files.
     * Delegates to {@link EmbeddingProcessor} which handles batching, diffing
     * against the database, embedding, and persistence.
     *
     * @param files - Array of FileIndex instances to compute embeddings for
     */
    private async computeEmbeddings(files: FileIndex[]): Promise<void> {
        if (files.length === 0) {
            return;
        }

        if (!this.embeddingProcessor) {
            warn('Content index: Cannot compute embeddings - not initialized');
            return;
        }

        await this.embeddingProcessor.run(files);
    }

    /**
     * Get all FileIndex instances in the cache.
     *
     * @param ensureValid - If true, indexes any files that don't have valid tags
     * @returns Array of FileIndex instances
     */
    async getAll(ensureValid: boolean = false): Promise<FileIndex[]> {
        const filePaths = Array.from(this.cache.values()).map(fi => fi.getFilePath());
        const result = await this.get(filePaths, ensureValid);
        return Array.from(result.values());
    }

    /**
     * Get all file paths in cache, optionally filtered by include/exclude glob patterns.
     *
     * @param include - Optional comma-separated glob patterns to include
     * @param exclude - Optional comma-separated glob patterns to exclude
     * @returns Array of absolute file paths (filtered if patterns provided)
     */
    getAllPaths(include?: string, exclude?: string): string[] {
        const paths = Array.from(this.cache.keys());

        if (!include && !exclude) {
            return paths;
        }

        // Parse comma-separated patterns
        const includePatterns = include ? include.split(',').map(p => p.trim()).filter(p => p) : [];
        const excludePatterns = exclude ? exclude.split(',').map(p => p.trim()).filter(p => p) : [];

        // Compile patterns to native RegExp for fast matching
        // windows: true makes regex match both / and \ separators
        const includeRegexes = includePatterns.map(p => picomatch.makeRe(p, { windows: true }));
        const excludeRegexes = excludePatterns.map(p => picomatch.makeRe(p, { windows: true }));

        return paths.filter(p => {
            // If include patterns specified, path must match at least one
            if (includeRegexes.length > 0 && !includeRegexes.some(re => re.test(p))) {
                return false;
            }

            // If exclude patterns specified, path must not match any
            if (excludeRegexes.length > 0 && excludeRegexes.some(re => re.test(p))) {
                return false;
            }

            return true;
        });
    }

    /**
     * Creates the {@link FileIndex} and marks the file as dirty.
     *
     * @param filePath - Absolute file path to add
     */
    add(filePath: string): void {
        const normalizedPath = this.normalizePath(filePath);
        if (!this.cache.has(normalizedPath) && this.pathFilter?.shouldIncludeFile(filePath)) {
            const fileIndex = new FileIndex(filePath, this.symbolsCacheDir);
            this.cache.set(normalizedPath, fileIndex);
            this.markDirty(filePath);
            log(`Content index: Added new file ${filePath}`);
        }
    }

    /**
     * Append a dirty mutation to the queue and wake the drain loop.
     * The drain loop will process it in the next cycle.
     * Safe to call multiple times — the reentrancy guard in
     * {@link wakeDrainLoop} makes redundant calls free.
     *
     * @param filePath - Absolute file path to mark dirty
     */
    markDirty(filePath: string): void {
        this.fileMutationQueue.push({ action: 'dirty', filePath });
        this.wakeDrainLoop();
    }

    /**
     * Append a delete mutation to the queue and wake the drain loop.
     * The drain loop will remove the file from cache and DB.
     * Safe to call multiple times — the reentrancy guard in
     * {@link wakeDrainLoop} makes redundant calls free.
     *
     * @param filePath - Absolute file path to mark deleted
     */
    markDeleted(filePath: string): void {
        this.fileMutationQueue.push({ action: 'delete', filePath });
        this.wakeDrainLoop();
    }

    /**
     * Start the drain loop if not already running.
     * Safe to call multiple times — a no-op if the loop is in-flight.
     * New entries are picked up naturally by the running loop's `while` condition.
     */
    private wakeDrainLoop(): void {
        if (this.drainLoopRunning) {
            return;
        }
        this.drainLoopRunning = true;
        this.drainLoopPromise = this.runDrainLoop().finally(() => {
            this.drainLoopRunning = false;
            this.drainLoopPromise = null;
        });
    }

    /**
     * Start the drain loop if needed, then await its completion.
     * Used by `get(ensureValid)` and `buildInitialIndex`.
     */
    private async awaitDrainLoop(): Promise<void> {
        if (!this.drainLoopRunning &&
            (this.fileMutationQueue.length > 0 || this.vectorQueryQueue.length > 0)) {
            this.wakeDrainLoop();
        }
        if (this.drainLoopPromise) {
            await this.drainLoopPromise;
        }
    }

    /**
     * Serial drain loop: processes all mutations until the index files
     * and database are consistent, then handles queued queries against
     * that quiescent snapshot. Repeats until no work remains.
     *
     * The inner loop drains all pending mutations (collapses the queue
     * using "last action wins", processes deletes, indexes dirty files
     * and generates embeddings). Only when no mutations remain does the
     * outer loop process queued queries.
     */
    private async runDrainLoop(): Promise<void> {
        while (this.fileMutationQueue.length > 0 || this.vectorQueryQueue.length > 0) {

            // Inner loop: drain ALL mutations until the
            // idx files and DB are fully consistent.
            while (this.fileMutationQueue.length > 0) {

                // 1. Collapse queue: for each filePath, only keep the LAST action.
                //    This preserves temporal ordering — delete→create keeps 'dirty',
                //    modify→delete keeps 'delete'.
                const lastAction = new Map<string, FileMutationEntry>();
                for (const entry of this.fileMutationQueue) {
                    lastAction.set(this.normalizePath(entry.filePath), entry);
                }
                this.fileMutationQueue.length = 0;

                // 2. Split into deletes and dirty files
                const deletedFiles: string[] = [];
                const dirtyFiles: FileIndex[] = [];
                for (const [normalizedPath, { action, filePath }] of lastAction) {
                    if (action === 'delete') {
                        deletedFiles.push(filePath);
                    } else {
                        const fi = this.cache.get(normalizedPath);
                        if (fi) {
                            dirtyFiles.push(fi);
                        }
                    }
                }

                // 3. Process deletes — remove from cache and DB
                for (const filePath of deletedFiles) {
                    this.remove(filePath);
                    if (this.vectorDatabase) {
                        await this.vectorDatabase.deleteByFilePath(filePath);
                    }
                }

                // 4. Index dirty files (includes post-validation)
                if (dirtyFiles.length > 0) {
                    await this.indexFiles(dirtyFiles);
                }

                // 5. Inner loop continues — picks up any new mutations
                //    that arrived during the awaits above
            }

            // ── DB and idx files are fully consistent at this point ──

            // 6. Process queued queries — guaranteed to see a quiescent snapshot
            if (this.vectorQueryQueue.length > 0) {
                const queries = [...this.vectorQueryQueue];
                this.vectorQueryQueue.length = 0;
                for (const query of queries) {
                    try {
                        if (!this.vectorDatabase) {
                            query.resolve([]);
                            continue;
                        }
                        const hits = await this.vectorDatabase.getNearestFileChunks(
                            query.vector, query.topK
                        );
                        // Convert cosine distance (0 = identical, 2 = opposite) to
                        // cosine similarity score (1 = identical, -1 = opposite)
                        query.resolve(hits.map(hit => ({
                            filePath: hit.filePath,
                            startLine: hit.startLine,
                            endLine: hit.endLine,
                            score: 1 - hit._distance,
                        })));
                    } catch (err) {
                        query.reject(err instanceof Error ? err : new Error(String(err)));
                    }
                }
            }

            // 7. Outer loop continues — if new mutations arrived during
            //    query processing, the inner loop will drain them before
            //    the next batch of queries executes
        }
    }

    /**
     * Remove a file from the in-memory cache.
     * Clears any associated cached symbols.
     *
     * @param filePath - Absolute file path to remove
     */
    private remove(filePath: string): void {
        const normalizedPath = this.normalizePath(filePath);
        const fileIndex = this.cache.get(normalizedPath);
        if (fileIndex) {
            fileIndex.invalidate();
            this.cache.delete(normalizedPath);
        }
    }

    /**
     * Get the number of files in the cache.
     */
    size(): number {
        return this.cache.size;
    }

    /**
     * Dispose of all resources held by this CacheManager.
     * Closes the vector database and clears internal state.
     */
    async dispose(): Promise<void> {
        // Clear queues and reject pending queries
        this.fileMutationQueue.length = 0;
        for (const query of this.vectorQueryQueue) {
            query.reject(new Error('CacheManager disposed'));
        }
        this.vectorQueryQueue.length = 0;

        // Wait for any in-flight drain loop to finish
        if (this.drainLoopPromise) {
            await this.drainLoopPromise;
        }

        if (this.vectorDatabase) {
            await this.vectorDatabase.close();
            this.vectorDatabase = null;
        }

        this.embeddingProcessor = null;
        this.threadPool = null;
        this.llamaServer = null;
        this.pathFilter = null;
        this.cache.clear();
        this.indexingComplete = false;
        this.indexingPromise = null;

        log('Content index: CacheManager disposed');
    }

    /**
     * Get the current include paths configuration.
     */
    getIncludePaths(): string[] {
        return this.pathFilter?.getIncludePaths() ?? [];
    }

    /**
     * Get the current file extensions configuration.
     */
    getFileExtensions(): string[] {
        return this.pathFilter?.getFileExtensions() ?? [];
    }

    /**
     * Search the vector database for the nearest embeddings to a query vector.
     * The query is enqueued and processed by the drain loop to ensure
     * it executes against a consistent, quiescent database snapshot.
     *
     * If the drain loop is idle (no dirty files, no deletes), the query
     * executes immediately — the loop wakes, skips mutations, runs the
     * query, and exits.
     *
     * @param queryVector - Embedding vector for the query (Float32Array of length `dims`)
     * @param topK - Maximum number of results to return
     * @returns Array of { filePath, startLine, endLine, score } ordered from
     * most to least similar. Score is cosine similarity (1 = identical,
     * -1 = opposite).
     */
    async getNearestEmbeddings(
        queryVector: Float32Array,
        topK: number,
    ): Promise<NearestEmbeddingResult[]> {
        if (!this.vectorDatabase) {
            return [];
        }

        return new Promise<NearestEmbeddingResult[]>((resolve, reject) => {
            this.vectorQueryQueue.push({ vector: queryVector, topK, resolve, reject });
            this.wakeDrainLoop();
        });
    }
}
