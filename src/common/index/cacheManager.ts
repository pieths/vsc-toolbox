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
import { VectorCacheClient } from './vectorCache/vectorCacheClient';
import { PathFilter } from './pathFilter';
import { SymbolCache } from './symbolCache';
import { FileSymbols } from './fileSymbols';
import { log, warn, error } from '../logger';

/** Mutation queue entry — ordered for temporal "last action wins" collapse. */
interface FileMutationEntry {
    action: 'dirty' | 'delete';
    filePath: string;
}

/** Pending task, resolved by the drain loop after all mutations are processed. */
type TaskEntry =
    | {
        type: 'vectorSearch'; vector: Float32Array; topK: number;
        resolve: (v: NearestEmbeddingResult[]) => void;
        reject: (e: unknown) => void
    }
    | {
        type: 'getAllSymbols'; filePaths: string[];
        resolve: (v: Map<string, FileSymbols>) => void;
        reject: (e: unknown) => void
    }
    | {
        type: 'compact';
        resolve: (v: void) => void;
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
    private vectorCacheClient: VectorCacheClient | null = null;
    private embeddingProcessor: EmbeddingProcessor | null = null;
    private symbolCache = new SymbolCache();

    // ── Dirty-set drain loop state ──────────────────────────────────────────
    private fileMutationQueue: FileMutationEntry[] = [];
    private taskQueue: TaskEntry[] = [];
    private drainLoopRunning = false;
    private drainLoopPromise: Promise<void> | null = null;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly debounceMs = 500;

    /**
     * Set to true by {@link buildInitialIndex} once the initial mutation
     * queue has been fully assembled.  Until then, {@link startDrainLoop}
     * is a no-op — this prevents the FileWatcher's debounced mutations
     * from starting the drain loop before all components are ready and
     * the complete set of initial mutations has been queued.
     */
    private mutationQueueInitialized = false;

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
        enableEmbeddings: boolean = false,
        nodePath: string = ''
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

            // Create vector cache client (child process with separate LanceDB)
            if (nodePath) {
                const cachePath = path.join(this.cacheDir, 'vectorcache');
                this.vectorCacheClient = new VectorCacheClient(
                    nodePath,
                    cachePath,
                    this.llamaServer.getDimensions(),
                );
                log(`Content index: VectorCacheClient created at ${cachePath}`);
            }

            this.embeddingProcessor = new EmbeddingProcessor(
                this.vectorDatabase,
                this.llamaServer,
                this.threadPool,
                this.vectorCacheClient,
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

            // Also reconcile file paths known to the vector database
            // that were NOT found on disk during the directory scan.
            //
            // Two cases:
            // (a) The file still passes shouldIncludeFile() — push as
            //     'dirty' so the worker thread determines ground truth
            //     by reading the file. If it hits ENOENT the drain loop
            //     will delete it. Using 'dirty' (not 'delete') avoids
            //     a race where a FileWatcher 'dirty' arrives for a newly
            //     created file during findFilesInDirectory — "last action
            //     wins" would discard the watcher's 'dirty' and
            //     incorrectly remove the file.
            //
            // (b) The file no longer passes shouldIncludeFile() (e.g.
            //     include paths or extensions changed) — push as 'delete'
            //     to unconditionally remove it from cache and DB. No race
            //     is possible because add() also gates on
            //     shouldIncludeFile(), so the FileWatcher would never
            //     enqueue a 'dirty' for this file.
            if (this.vectorDatabase) {
                const discoveredPaths = new Set(
                    filePaths.map(fp => this.normalizePath(fp))
                );
                for (const dbPath of this.vectorDatabase.getAllFilePaths()) {
                    if (!discoveredPaths.has(this.normalizePath(dbPath))) {
                        if (this.pathFilter!.shouldIncludeFile(dbPath)) {
                            this.fileMutationQueue.push({ action: 'dirty', filePath: dbPath });
                        } else {
                            this.fileMutationQueue.push({ action: 'delete', filePath: dbPath });
                        }
                    }
                }
            }

            // Initial mutation queue is fully assembled — allow
            // the drain loop to start. Any mutations queued by the
            // FileWatcher during the directory scan are still in the
            // queue and will be processed together with the initial batch.
            this.mutationQueueInitialized = true;

            // Drain all mutations — blocks until the
            // inner drain loop fully converges
            await this.awaitDrainLoop();

            // Optimize the vector database — compacts data files,
            // prunes old table versions, and updates scalar indices
            // with data added during the initial drain. Runs inside
            // the drain loop to avoid concurrent DB access.
            if (this.vectorDatabase) {
                await this.compactDatabase();
            }

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
     * Index and compute embeddings for a batch
     * of files via worker threads.
     *
     * @param fileRefs - Array of FileRef handles to index
     * @returns Array of file paths whose source was deleted (ENOENT) before indexing
     */
    private async indexFiles(fileRefs: FileRef[]): Promise<string[]> {
        if (!this.threadPool) {
            warn('Content index: Cannot index - thread pool not set');
            return [];
        }

        const inputs: IndexInput[] = fileRefs.map(fi => ({
            type: 'index' as const,
            filePath: fi.getFilePath(),
            idxPath: fi.getIdxPath()
        }));

        const startTime = Date.now();
        const outputs = await this.threadPool.indexAll(inputs);

        // Collect files whose source was deleted
        // before the worker could read them
        const deletedPaths = outputs
            .filter(o => o.status === IndexStatus.Deleted)
            .map(o => o.filePath);

        // Only compute embeddings for files that were not deleted
        const deletedSet = new Set(deletedPaths.map(p => this.normalizePath(p)));
        const existingRefs = fileRefs.filter(
            fi => !deletedSet.has(this.normalizePath(fi.getFilePath()))
        );
        await this.computeEmbeddings(existingRefs);

        const elapsed = Date.now() - startTime;
        const deletedCount = deletedPaths.length;
        const indexedCount = outputs.filter(o => o.status === IndexStatus.Indexed).length;
        const skippedCount = outputs.filter(o => o.status === IndexStatus.Skipped).length;
        if (indexedCount > 0 || skippedCount > 0 || deletedPaths.length > 0) {
            log(`Content index: Indexed ${indexedCount} files (${skippedCount} skipped, ${deletedCount} deleted) in ${elapsed}ms`);
        }

        return deletedPaths;
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
        if (this.drainLoopRunning || !this.mutationQueueInitialized) {
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
            (this.fileMutationQueue.length > 0 || this.taskQueue.length > 0)) {
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
        while (this.fileMutationQueue.length > 0 || this.taskQueue.length > 0) {

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

                // 3. Index dirty files first — workers detect ENOENT for
                //    source files deleted before the watcher could notify
                //    us. These deleted files should be removed from the
                //    cache immediately.
                if (dirtyFiles.length > 0) {
                    const discoveredDeletes = await this.indexFiles(dirtyFiles);
                    for (const dp of discoveredDeletes) {
                        deletedFiles.push(dp);
                    }
                }

                // 4. Process all deletes — both explicitly queued and
                //    discovered during indexing — remove from cache and DB
                for (const filePath of deletedFiles) {
                    log(`Content index: Removed file ${filePath}`);
                    this.remove(filePath);
                }
                if (this.vectorDatabase && deletedFiles.length > 0) {
                    await this.vectorDatabase.deleteByFilePaths(deletedFiles);
                }

                // 5. Inner loop continues — picks up any new mutations
                //    that arrived during the awaits above
            }

            // ── DB and idx files are fully consistent at this point ──

            // 6. Dispatch queued tasks against the quiescent snapshot
            if (this.taskQueue.length > 0) {
                const tasks = [...this.taskQueue];
                this.taskQueue.length = 0;
                for (const task of tasks) {
                    await this.executeTask(task);
                }
            }

            // 7. Outer loop continues — if new mutations arrived during
            //    task processing, the inner loop will drain them before
            //    the next batch of tasks executes
        }
    }

    // ── Task execution handlers ──────────────────────────────────────────────

    /**
     * Dispatch a single task to the appropriate handler.
     */
    private async executeTask(task: TaskEntry): Promise<void> {
        switch (task.type) {
            case 'vectorSearch': return this.executeVectorSearch(task);
            case 'getAllSymbols': return this.executeGetAllSymbols(task);
            case 'compact': return this.executeCompact(task);
        }
    }

    private async executeVectorSearch(
        query: Extract<TaskEntry, { type: 'vectorSearch' }>,
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
        query: Extract<TaskEntry, { type: 'getAllSymbols' }>,
    ): Promise<void> {
        try {
            const results = new Map<string, FileSymbols>();
            for (const filePath of query.filePaths) {
                const fileRef = this.cache.get(this.normalizePath(filePath));
                if (!fileRef) {
                    continue;  // File not in index
                }
                const symbols = await this.symbolCache.getSymbols(fileRef);
                if (symbols !== null) {
                    results.set(filePath, new FileSymbols(fileRef, symbols));
                }
            }
            query.resolve(results);
        } catch (err) {
            query.reject(err instanceof Error ? err : new Error(String(err)));
        }
    }

    private async executeCompact(
        task: Extract<TaskEntry, { type: 'compact' }>,
    ): Promise<void> {
        try {
            if (!this.vectorDatabase) {
                task.resolve();
                return;
            }
            await this.vectorDatabase.compact();
            task.resolve();
        } catch (err) {
            task.reject(err instanceof Error ? err : new Error(String(err)));
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

        // Clear queues and reject pending tasks
        this.fileMutationQueue.length = 0;
        for (const task of this.taskQueue) {
            task.reject(new Error('CacheManager disposed'));
        }
        this.taskQueue.length = 0;

        // Wait for any in-flight drain loop to finish
        if (this.drainLoopPromise) {
            await this.drainLoopPromise;
        }

        if (this.vectorDatabase) {
            await this.vectorDatabase.close();
            this.vectorDatabase = null;
        }

        if (this.vectorCacheClient) {
            await this.vectorCacheClient.dispose();
            this.vectorCacheClient = null;
        }

        this.embeddingProcessor = null;
        this.threadPool = null;
        this.llamaServer = null;
        this.pathFilter = null;
        this.cache.clear();
        this.indexingComplete = false;
        this.indexingPromise = null;
        this.mutationQueueInitialized = false;

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

    // ── Drain-loop-serialized task methods ───────────────────────────────────

    /**
     * Get hydrated symbols for one or more files.
     * The task is enqueued and processed by the drain loop to ensure
     * it executes against a consistent, quiescent snapshot.
     *
     * Files not in the index or whose `*.idx` file cannot be read are
     * silently omitted from the returned map.
     *
     * @param filePaths - Array of absolute file paths to load symbols for
     * @returns Map of file path to FileSymbols (only includes files that were successfully read)
     */
    async getAllSymbols(filePaths: string[]): Promise<Map<string, FileSymbols>> {
        return new Promise<Map<string, FileSymbols>>((resolve, reject) => {
            this.taskQueue.push({ type: 'getAllSymbols', filePaths, resolve, reject });
            this.wakeDrainLoop(false);
        });
    }

    /**
     * Search the vector database for the nearest embeddings to a query vector.
     * The task is enqueued and processed by the drain loop to ensure
     * it executes against a consistent, quiescent database snapshot.
     *
     * If the drain loop is idle (no dirty files, no deletes), the task
     * executes immediately — the loop wakes, skips mutations, runs the
     * task, and exits.
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
            this.taskQueue.push({ type: 'vectorSearch', vector: queryVector, topK, resolve, reject });
            this.wakeDrainLoop(false);
        });
    }

    /**
     * Optimize the vector database — compacts data files to reclaim
     * disk space from logically-deleted rows, prunes old table
     * versions, and updates scalar indices with new data.
     *
     * The task is enqueued and processed by the drain loop to ensure
     * it runs during a quiescent window with no concurrent DB access.
     */
    async compactDatabase(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.taskQueue.push({ type: 'compact', resolve, reject });
            this.wakeDrainLoop(false);
        });
    }
}
