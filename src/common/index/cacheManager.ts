// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import picomatch from 'picomatch';
import { FileIndex } from './fileIndex';
import { ThreadPool } from './threadPool';
import { IndexInput, NearestEmbeddingResult } from './types';
import { LlamaServer } from './llamaServer';
import { VectorDatabase } from './vectorDatabase';
import { EmbeddingProcessor } from './embeddingProcessor';
import { PathFilter } from './pathFilter';
import { log, warn, error } from '../logger';

/**
 * CacheManager manages the collection of FileIndex instances and coordinates
 * cache operations across all indexed files.
 */
export class CacheManager {
    private cache: Map<string, FileIndex> = new Map();
    private indexingComplete: boolean = false;
    private indexingPromise: Promise<void> | null = null;
    private pathFilter: PathFilter | null = null;
    private ctagsPath: string = 'ctags';
    private cacheDir: string = '';
    private ctagsCacheDir: string = '';
    private threadPool: ThreadPool | null = null;
    private llamaServer: LlamaServer | null = null;
    private vectorDatabase: VectorDatabase | null = null;
    private embeddingProcessor: EmbeddingProcessor | null = null;

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
     * @param ctagsPath - Path to the ctags executable
     * @param threadPool - Thread pool manager for indexing operations
     * @param llamaServer - Llama server instance for computing embeddings
     */
    async initialize(
        pathFilter: PathFilter,
        ctagsPath: string,
        threadPool: ThreadPool,
        llamaServer: LlamaServer
    ): Promise<void> {
        this.pathFilter = pathFilter;
        this.ctagsPath = ctagsPath;
        this.threadPool = threadPool;
        this.llamaServer = llamaServer;
        this.indexingComplete = false;

        // Compute cache directory once from first workspace folder
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        this.cacheDir = workspaceFolder
            ? path.join(workspaceFolder.uri.fsPath, '.cache', 'vsctoolbox', 'index')
            : '';

        // Open (or create) the vector database
        if (this.cacheDir) {
            const dbPath = path.join(this.cacheDir, 'vectordb');
            this.vectorDatabase = new VectorDatabase(dbPath, this.llamaServer.getDimensions());
            await this.vectorDatabase.open();
            log(`Content index: VectorDatabase opened at ${dbPath}`);
        }

        this.embeddingProcessor = new EmbeddingProcessor(
            this.vectorDatabase,
            this.llamaServer,
            this.threadPool,
        );

        // Ensure ctags cache directory and a-z subdirectories exist
        this.ctagsCacheDir = this.cacheDir ? path.join(this.cacheDir, 'ctags') : '';
        if (this.ctagsCacheDir) {
            const alphabet = 'abcdefghijklmnopqrstuvwxyz';
            // Create a subdirectory for each letter plus '_' for non-alpha filenames
            const subdirs = [...alphabet, '_'].map(ch => path.join(this.ctagsCacheDir, ch));
            await Promise.all(subdirs.map(dir => fs.promises.mkdir(dir, { recursive: true })));
        }

        log(`Content index: includePaths =\n${JSON.stringify(pathFilter.getIncludePaths(), null, 2)}`);
        log(`Content index: fileExtensions =\n${JSON.stringify(pathFilter.getFileExtensions(), null, 2)}`);
        log(`Content index: ctagsPath = ${ctagsPath}`);
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
            const includePaths = this.pathFilter!.getIncludePaths();

            if (includePaths.length === 0) {
                // Fall back to workspace folders if no includePaths specified
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders) {
                    const fallbackPaths: string[] = [];
                    for (const folder of workspaceFolders) {
                        fallbackPaths.push(folder.uri.fsPath);
                    }
                    this.pathFilter!.setIncludePaths(fallbackPaths);
                }
                log('Content index: No includePaths configured, using workspace folders');
            }

            // Scan each includePath directory for matching files
            for (const includePath of this.pathFilter!.getIncludePaths()) {
                try {
                    const files = await this.findFilesInDirectory(includePath);
                    // Use concat instead of spread to avoid stack overflow with large arrays
                    for (const file of files) {
                        filePaths.push(file);
                    }
                    log(`Content index: Found ${files.length} files in ${includePath}`);
                } catch (err) {
                    warn(`Content index: Failed to scan directory ${includePath}: ${err}`);
                }
            }

            log(`Content index: Total files to add: ${filePaths.length}`);

            // Process files in batches to stay responsive
            const batchSize = 500;
            let lastYield = Date.now();

            for (let i = 0; i < filePaths.length; i += batchSize) {
                const batch = filePaths.slice(i, i + batchSize);

                // Create FileIndex instances for each file
                // isValid() handles cache restoration automatically via mtime comparison
                for (const filePath of batch) {
                    const fileIndex = new FileIndex(filePath, this.ctagsCacheDir);
                    this.cache.set(this.normalizePath(filePath), fileIndex);
                }

                // Yield to event loop every 50ms to stay responsive
                const now = Date.now();
                if (now - lastYield > 50) {
                    await new Promise(resolve => setImmediate(resolve));
                    lastYield = Date.now();
                }
            }

            // Index all discovered files
            const allFiles = Array.from(this.cache.values());
            await this.indexFiles(allFiles);

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
        const toIndex: FileIndex[] = [];

        // Look up all FileIndex instances and collect those needing indexing
        for (const filePath of filePaths) {
            const fileIndex = this.cache.get(this.normalizePath(filePath));
            if (fileIndex) {
                result.set(filePath, fileIndex);
                if (ensureValid && !fileIndex.isValid()) {
                    toIndex.push(fileIndex);
                }
            }
        }

        // Batch index all invalid files
        if (toIndex.length > 0) {
            await this.indexFiles(toIndex);
        }

        return result;
    }

    /**
     * Index a batch of FileIndex instances.
     *
     * @param toIndex - Array of FileIndex instances to index
     */
    private async indexFiles(toIndex: FileIndex[]): Promise<void> {
        if (!this.threadPool) {
            warn('Content index: Cannot ensure valid - thread pool not set');
            return;
        }

        const inputs: IndexInput[] = toIndex.map(fi => ({
            type: 'index' as const,
            filePath: fi.getFilePath(),
            ctagsPath: this.ctagsPath,
            tagsPath: fi.getTagsPath()
        }));

        const startTime = Date.now();
        const outputs = await this.threadPool.indexAll(inputs);

        let successCount = 0;
        for (const output of outputs) {
            if (output.tagsPath && !output.error) {
                successCount++;
            }
        }

        await this.computeEmbeddings(toIndex);
        const elapsed = Date.now() - startTime;

        if (successCount > 0) {
            log(`Content index: Indexed ${successCount} files in ${elapsed}ms`);
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
     * Add a new file to cache.
     *
     * @param filePath - Absolute file path to add
     */
    add(filePath: string): void {
        const normalizedPath = this.normalizePath(filePath);
        if (!this.cache.has(normalizedPath) && this.pathFilter?.shouldIncludeFile(filePath)) {
            const fileIndex = new FileIndex(filePath, this.ctagsCacheDir);
            this.cache.set(normalizedPath, fileIndex);
            this.indexFiles([fileIndex]);
            log(`Content index: Added new file ${filePath}`);
        }
    }

    /**
     * Invalidate cache for a specific file.
     *
     * @param filePath - Absolute file path to invalidate
     */
    invalidate(filePath: string): void {
        const fileIndex = this.cache.get(this.normalizePath(filePath));
        if (fileIndex) {
            // FileWatcher.handleChange can fire even if there were no
            // actual content changes to the file. Validate that there were
            // actual changes before re-indexing to avoid unnecessary work.
            if (!fileIndex.isValid()) {
                this.indexFiles([fileIndex]);
            }
            fileIndex.invalidate();
        }
    }

    /**
     * Remove a file from cache.
     * Cleans up any associated tags file.
     *
     * @param filePath - Absolute file path to remove
     */
    remove(filePath: string): void {
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
     * Clear cache and rebuild.
     * Called when configuration changes after initialization.
     */
    private rebuild(): void {
        this.cache.clear();
        this.indexingComplete = false;
        this.indexingPromise = this.buildInitialIndex();
    }

    /**
     * Update configuration and rebuild the cache.
     * Triggers a full rebuild if already initialized.
     *
     * @param pathFilter - New PathFilter instance
     */
    updateConfig(pathFilter: PathFilter): void {
        this.pathFilter = pathFilter;
        this.rebuild();
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
     *
     * @param queryVector - Embedding vector for the query (Float32Array of length `dims`)
     * @param topK - Maximum number of results to return
     * @returns Array of { filePath, startLine, endLine, score } ordered from most to least similar
     */
    async getNearestEmbeddings(
        queryVector: Float32Array,
        topK: number,
    ): Promise<NearestEmbeddingResult[]> {
        if (!this.vectorDatabase) {
            return [];
        }

        const hits = await this.vectorDatabase.getNearestFileChunks(queryVector, topK);

        // Convert cosine distance (0 = identical, 2 = opposite) to
        // cosine similarity score (1 = identical, -1 = opposite)
        return hits.map(hit => ({
            filePath: hit.filePath,
            startLine: hit.startLine,
            endLine: hit.endLine,
            score: 1 - hit._distance,
        }));
    }
}
