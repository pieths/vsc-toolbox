// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import picomatch from 'picomatch';
import { FileRef } from './fileRef';
import { ThreadPool } from './workers/threadPool';
import { IndexInput, IndexStatus, NearestEmbeddingResult } from './types';
import { LlamaServer } from './embeddings/llamaServer';
import { VectorDatabase } from './embeddings/vectorDatabase';
import { EmbeddingProcessor } from './embeddings/embeddingProcessor';
import { PathFilter } from './pathFilter';
import { SymbolCache } from './symbolCache';
import { AttrKey, CONTAINER_TYPES } from './parsers/types';
import type { IndexSymbol } from './parsers/types';
import { log, warn, error } from '../logger';

/** Mutation queue entry — ordered for temporal "last action wins" collapse. */
interface FileMutationEntry {
    action: 'dirty' | 'delete';
    filePath: string;
}

/** Pending query, resolved by the drain loop after all mutations are processed. */
type QueryEntry =
    | {
        type: 'vectorSearch'; vector: Float32Array; topK: number;
        resolve: (v: NearestEmbeddingResult[]) => void;
        reject: (e: unknown) => void
    }
    | {
        type: 'getAllSymbols'; fileRef: FileRef; sort: boolean;
        resolve: (v: IndexSymbol[] | null) => void;
        reject: (e: unknown) => void
    }
    | {
        type: 'getContainer'; fileRef: FileRef; line: number;
        resolve: (v: IndexSymbol | null) => void;
        reject: (e: unknown) => void
    }
    | {
        type: 'getFQN'; fileRef: FileRef; name: string; line: number;
        resolve: (v: string) => void;
        reject: (e: unknown) => void
    };

/**
 * CacheManager manages the collection of FileRef handles and coordinates
 * cache operations across all indexed files.
 *
 * All indexing and embedding work is driven by a single serial drain loop
 * that consumes from an ordered {@link fileMutationQueue}. This eliminates
 * race conditions from overlapping `indexAll()` calls and ensures queries
 * always see a consistent, quiescent database snapshot.
 */
export class CacheManager {
    private cache: Map<string, FileRef> = new Map();
    private indexingComplete: boolean = false;
    private indexingPromise: Promise<void> | null = null;
    private pathFilter: PathFilter | null = null;
    private cacheDir: string = '';
    private symbolsCacheDir: string = '';
    private threadPool: ThreadPool | null = null;
    private llamaServer: LlamaServer | null = null;
    private vectorDatabase: VectorDatabase | null = null;
    private embeddingProcessor: EmbeddingProcessor | null = null;
    private symbolCache = new SymbolCache();

    // ── Dirty-set drain loop state ──────────────────────────────────────────
    private fileMutationQueue: FileMutationEntry[] = [];
    private queryQueue: QueryEntry[] = [];
    private drainLoopRunning = false;
    private drainLoopPromise: Promise<void> | null = null;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly debounceMs = 500;

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

            // Create FileRef handles for each file
            for (const filePath of filePaths) {
                const key = this.normalizePath(filePath);
                if (this.cache.has(key)) {
                    log(`Content index: Duplicate path: "${filePath}" (existing: "${this.cache.get(key)!.getFilePath()}")`);
                    continue;
                }
                const fileRef = new FileRef(filePath, this.symbolsCacheDir);
                this.cache.set(key, fileRef);
            }

            // Push all discovered files to the mutation queue for the drain loop.
            // Assume everthing might be dirty. The worker threads will skip
            // indexing if it's not needed.
            for (const [_key, fileRef] of this.cache) {
                this.fileMutationQueue.push({ action: 'dirty', filePath: fileRef.getFilePath() });
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
     * Get FileRef handles for multiple paths.
     * Returns whatever is in the cache immediately. Consistency is
     * guaranteed at read time when the caller passes the FileRef
     * to a drain-loop-gated query method.
     *
     * @param filePaths - Array of absolute file paths
     * @returns Map of file path to FileRef (only includes paths that are in cache)
     */
    get(filePaths: string[]): Map<string, FileRef> {
        const result = new Map<string, FileRef>();

        for (const filePath of filePaths) {
            const fileRef = this.cache.get(this.normalizePath(filePath));
            if (fileRef) {
                result.set(filePath, fileRef);
            }
        }

        return result;
    }

    /**
     * Index a batch of files via worker threads and compute
     * embeddings for files that were actually re-indexed.
     *
     * @param fileRefs - Array of FileRef handles to index
     */
    private async indexFiles(fileRefs: FileRef[]): Promise<void> {
        if (!this.threadPool) {
            warn('Content index: Cannot index - thread pool not set');
            return;
        }

        const inputs: IndexInput[] = fileRefs.map(fi => ({
            type: 'index' as const,
            filePath: fi.getFilePath(),
            idxPath: fi.getIdxPath()
        }));

        const startTime = Date.now();
        const outputs = await this.threadPool.indexAll(inputs);

        await this.computeEmbeddings(fileRefs);

        const elapsed = Date.now() - startTime;
        const indexed = outputs.filter(o => o.status === IndexStatus.Indexed);
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
     * @param files - Array of FileRef handles to compute embeddings for
     */
    private async computeEmbeddings(files: FileRef[]): Promise<void> {
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
        // nocase: true because cache keys are lowercased via normalizePath()
        const globOptions = { windows: true, nocase: true };
        const includeRegexes = includePatterns.map(p => picomatch.makeRe(p, globOptions));
        const excludeRegexes = excludePatterns.map(p => picomatch.makeRe(p, globOptions));

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
     * Filter the file and mark it dirty.  The drain loop will
     * auto-create the cache entry if one doesn't already exist.
     *
     * @param filePath - Absolute file path to add
     */
    add(filePath: string): void {
        if (this.pathFilter?.shouldIncludeFile(filePath)) {
            this.markDirty(filePath);
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
        this.wakeDrainLoop(true);
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
        this.wakeDrainLoop(true);
    }

    /**
     * Start the drain loop, optionally after a debounce delay.
     *
     * Debounced mode (`debounce = true`) is used by mutation sources
     * (FileWatcher via `markDirty` / `markDeleted`) to batch rapid
     * file-system events into a single drain loop run.
     *
     * Immediate mode (`debounce = false`) is used by query methods
     * and `awaitDrainLoop` — when a caller needs results now, don't
     * wait for the timer.  Cancels any pending debounce timer.
     *
     * Safe to call multiple times — a no-op if the loop is already
     * running. New entries are picked up naturally by the running
     * loop's `while` condition.
     */
    private wakeDrainLoop(debounce: boolean = false): void {
        if (this.drainLoopRunning) {
            return;
        }
        if (debounce) {
            if (this.debounceTimer) {
                clearTimeout(this.debounceTimer);
            }
            this.debounceTimer = setTimeout(() => {
                this.debounceTimer = null;
                this.startDrainLoop();
            }, this.debounceMs);
        } else {
            if (this.debounceTimer) {
                clearTimeout(this.debounceTimer);
                this.debounceTimer = null;
            }
            this.startDrainLoop();
        }
    }

    /**
     * Actually start the drain loop. Factored out of {@link wakeDrainLoop}
     * so both the immediate and debounced paths share the same logic.
     */
    private startDrainLoop(): void {
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
     * Start the drain loop immediately if needed, then await its completion.
     */
    private async awaitDrainLoop(): Promise<void> {
        if (!this.drainLoopRunning &&
            (this.fileMutationQueue.length > 0 || this.queryQueue.length > 0)) {
            this.wakeDrainLoop(false);
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
        while (this.fileMutationQueue.length > 0 || this.queryQueue.length > 0) {

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
                const dirtyFiles: FileRef[] = [];
                for (const [normalizedPath, { action, filePath }] of lastAction) {
                    if (action === 'delete') {
                        deletedFiles.push(filePath);
                    } else {
                        let fi = this.cache.get(normalizedPath);
                        if (!fi) {
                            fi = new FileRef(filePath, this.symbolsCacheDir);
                            this.cache.set(normalizedPath, fi);
                            log(`Content index: Added new file ${filePath}`);
                        }
                        dirtyFiles.push(fi);
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

            // 6. Dispatch queued queries against the quiescent snapshot
            if (this.queryQueue.length > 0) {
                const queries = [...this.queryQueue];
                this.queryQueue.length = 0;
                for (const query of queries) {
                    await this.executeQuery(query);
                }
            }

            // 7. Outer loop continues — if new mutations arrived during
            //    query processing, the inner loop will drain them before
            //    the next batch of queries executes
        }
    }

    // ── Query execution handlers ────────────────────────────────────────────

    /**
     * Dispatch a single query to the appropriate handler.
     */
    private async executeQuery(query: QueryEntry): Promise<void> {
        switch (query.type) {
            case 'vectorSearch': return this.executeVectorSearch(query);
            case 'getAllSymbols': return this.executeGetAllSymbols(query);
            case 'getContainer': return this.executeGetContainer(query);
            case 'getFQN': return this.executeGetFQN(query);
        }
    }

    private async executeVectorSearch(
        query: Extract<QueryEntry, { type: 'vectorSearch' }>,
    ): Promise<void> {
        try {
            if (!this.vectorDatabase) {
                query.resolve([]);
                return;
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

    private async executeGetAllSymbols(
        query: Extract<QueryEntry, { type: 'getAllSymbols' }>,
    ): Promise<void> {
        try {
            const symbols = await this.symbolCache.getSymbols(query.fileRef);
            if (symbols && query.sort) {
                query.resolve([...symbols].sort((a, b) => a.startLine - b.startLine));
            } else {
                query.resolve(symbols);
            }
        } catch (err) {
            query.reject(err instanceof Error ? err : new Error(String(err)));
        }
    }

    private async executeGetContainer(
        query: Extract<QueryEntry, { type: 'getContainer' }>,
    ): Promise<void> {
        try {
            const symbols = await this.symbolCache.getSymbols(query.fileRef);
            if (symbols === null) {
                query.resolve(null);
                return;
            }
            const containers = symbols.filter(s =>
                CONTAINER_TYPES.has(s.type) &&
                s.startLine <= query.line &&
                query.line <= s.endLine
            );
            query.resolve(this.symbolCache.findInnermostSymbol(containers));
        } catch (err) {
            query.reject(err instanceof Error ? err : new Error(String(err)));
        }
    }

    private async executeGetFQN(
        query: Extract<QueryEntry, { type: 'getFQN' }>,
    ): Promise<void> {
        try {
            const symbols = await this.symbolCache.getSymbols(query.fileRef);
            if (symbols === null) {
                query.resolve(query.name);
                return;
            }
            const matches = symbols.filter(s =>
                s.name === query.name &&
                s.startLine <= query.line &&
                query.line <= s.endLine
            );
            const best = this.symbolCache.findInnermostSymbol(matches);
            if (!best) {
                query.resolve(query.name);
                return;
            }
            query.resolve(best.attrs.get(AttrKey.FullyQualifiedName) ?? best.name);
        } catch (err) {
            query.reject(err instanceof Error ? err : new Error(String(err)));
        }
    }

    /**
     * Remove a file from the in-memory cache.
     * Evicts any associated cached symbols.
     *
     * @param filePath - Absolute file path to remove
     */
    private remove(filePath: string): void {
        const normalizedPath = this.normalizePath(filePath);
        const fileRef = this.cache.get(normalizedPath);
        if (fileRef) {
            this.symbolCache.invalidateSymbols(fileRef);
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
        // Cancel any pending debounce timer
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }

        // Clear queues and reject pending queries
        this.fileMutationQueue.length = 0;
        for (const query of this.queryQueue) {
            query.reject(new Error('CacheManager disposed'));
        }
        this.queryQueue.length = 0;

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

    // ── Drain-loop-gated query methods ──────────────────────────────────────

    /**
     * Get all hydrated symbols for a file.
     * The query is enqueued and processed by the drain loop to ensure
     * it executes against a consistent, quiescent snapshot.
     *
     * @param fileRef - FileRef handle for the file
     * @param sort - If true, sort symbols by start line (ascending)
     * @returns Array of IndexSymbol objects, or null if the idx file cannot be read
     */
    async getAllSymbols(fileRef: FileRef, sort: boolean = false): Promise<IndexSymbol[] | null> {
        return new Promise<IndexSymbol[] | null>((resolve, reject) => {
            this.queryQueue.push({ type: 'getAllSymbols', fileRef, sort, resolve, reject });
            this.wakeDrainLoop(false);
        });
    }

    /**
     * Get the innermost container (function, class, namespace, etc.)
     * that contains a given line.
     * The query is enqueued and processed by the drain loop to ensure
     * it executes against a consistent, quiescent snapshot.
     *
     * @param fileRef - FileRef handle for the file
     * @param line - 0-based line number
     * @returns The innermost containing IndexSymbol, or null if none found
     */
    async getContainer(fileRef: FileRef, line: number): Promise<IndexSymbol | null> {
        return new Promise<IndexSymbol | null>((resolve, reject) => {
            this.queryQueue.push({ type: 'getContainer', fileRef, line, resolve, reject });
            this.wakeDrainLoop(false);
        });
    }

    /**
     * Get the fully qualified name for a symbol at a given line.
     * The query is enqueued and processed by the drain loop to ensure
     * it executes against a consistent, quiescent snapshot.
     *
     * @param fileRef - FileRef handle for the file
     * @param name - The symbol name to look up
     * @param line - 0-based line number
     * @returns The fully qualified name or the original name if not found
     */
    async getFullyQualifiedName(fileRef: FileRef, name: string, line: number): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            this.queryQueue.push({ type: 'getFQN', fileRef, name, line, resolve, reject });
            this.wakeDrainLoop(false);
        });
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
            this.queryQueue.push({ type: 'vectorSearch', vector: queryVector, topK, resolve, reject });
            this.wakeDrainLoop(false);
        });
    }
}
