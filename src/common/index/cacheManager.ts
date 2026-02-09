// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import picomatch from 'picomatch';
import { FileIndex } from './fileIndex';
import { ThreadPool } from './threadPool';
import {
    IndexInput,
    ComputeChunksInput,
    ComputeChunksOutput,
    SearchEmbeddingsInput,
    NearestEmbeddingResult,
} from './types';
import { LlamaServer } from './llamaServer';
import { VectorCache } from './vectorCache';
import { log, warn, error } from '../logger';

/**
 * CacheManager manages the collection of FileIndex instances and coordinates
 * cache operations across all indexed files.
 */
export class CacheManager {
    private cache: Map<string, FileIndex> = new Map();
    private indexingComplete: boolean = false;
    private indexingPromise: Promise<void> | null = null;
    private includePaths: string[] = [];
    private fileExtensions: string[] = ['.cc', '.h'];
    private ctagsPath: string = 'ctags';
    private cacheDir: string = '';
    private threadPool: ThreadPool | null = null;
    private llamaServer: LlamaServer | null = null;
    private vectorCache: VectorCache | null = null;

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
     * @param includePaths - List of directory paths to include (empty = all files)
     * @param fileExtensions - List of file extensions to include (e.g., '.cc', '.h')
     * @param ctagsPath - Path to the ctags executable
     * @param threadPool - Thread pool manager for indexing operations
     * @param llamaServer - Llama server instance for computing embeddings
     */
    async initialize(
        includePaths: string[],
        fileExtensions: string[],
        ctagsPath: string,
        threadPool: ThreadPool,
        llamaServer: LlamaServer
    ): Promise<void> {
        this.includePaths = includePaths;
        this.fileExtensions = fileExtensions.map(ext => ext.toLowerCase());
        this.ctagsPath = ctagsPath;
        this.threadPool = threadPool;
        this.llamaServer = llamaServer;
        this.indexingComplete = false;

        // Compute cache directory once from first workspace folder
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        this.cacheDir = workspaceFolder
            ? path.join(workspaceFolder.uri.fsPath, '.cache', 'vsctoolbox', 'index')
            : '';

        // Try to restore the vector cache from disk, or create a fresh one
        if (this.cacheDir) {
            this.vectorCache = await VectorCache.load(this.cacheDir) ?? new VectorCache(this.cacheDir);
            log(`Content index: VectorCache allocated ${this.vectorCache.allocatedBytes.toLocaleString()} bytes`);
        }

        // Ensure cache directory and a-z subdirectories exist
        if (this.cacheDir) {
            const alphabet = 'abcdefghijklmnopqrstuvwxyz';
            // Create a subdirectory for each letter plus '_' for non-alpha filenames
            const subdirs = [...alphabet, '_'].map(ch => path.join(this.cacheDir, ch));
            await Promise.all(subdirs.map(dir => fs.promises.mkdir(dir, { recursive: true })));
        }

        log(`Content index: includePaths =\n${JSON.stringify(includePaths, null, 2)}`);
        log(`Content index: fileExtensions =\n${JSON.stringify(this.fileExtensions, null, 2)}`);
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

            if (this.includePaths.length === 0) {
                // Fall back to workspace folders if no includePaths specified
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders) {
                    for (const folder of workspaceFolders) {
                        this.includePaths.push(folder.uri.fsPath);
                    }
                }
                log('Content index: No includePaths configured, using workspace folders');
            }

            // Scan each includePath directory for matching files
            for (const includePath of this.includePaths) {
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
                    const fileIndex = new FileIndex(filePath, this.cacheDir);
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
                const ext = path.extname(entry.name).toLowerCase();
                if (this.fileExtensions.includes(ext)) {
                    // entry.parentPath is available in Node 18.17+ with recursive option
                    const fullPath = path.join(entry.parentPath || dirPath, entry.name);
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
     * Processes files in batches: for each batch, computes chunks via worker
     * threads, then sends the chunk texts to the llama server for embedding.
     *
     * @param files - Array of FileIndex instances to compute embeddings for
     */
    private async computeEmbeddings(files: FileIndex[]): Promise<void> {
        if (files.length === 0) {
            return;
        }

        if (!this.threadPool) {
            warn('Content index: Cannot compute embeddings - thread pool not set');
            return;
        }

        if (!this.llamaServer || !this.llamaServer.isReady()) {
            warn('Content index: Cannot compute embeddings - llama server not ready');
            return;
        }
        const batchSize = 50;
        const startTime = Date.now();
        let totalChunks = 0;
        let totalVectors = 0;
        let totalFiles = 0;

        // Skip files whose content hasn't changed since last embedding
        files = await this.filterUnchangedFiles(files);

        if (files.length === 0) {
            return;
        }

        log(`Content index: Starting embedding for ${files.length} files`);

        for (let i = 0; i < files.length; i += batchSize) {
            const batch = files.slice(i, i + batchSize);

            // 1. Compute chunks for this batch via worker threads
            const chunkInputs: ComputeChunksInput[] = batch.map(fi => ({
                type: 'computeChunks' as const,
                filePath: fi.getFilePath(),
                ctagsPath: fi.getTagsPath(),
            }));

            const chunkOutputs = await this.threadPool.computeChunksAll(chunkInputs);

            // 2. For each file's chunks, get embeddings from llama server
            for (const chunkOutput of chunkOutputs) {
                totalChunks += chunkOutput.chunks.length;

                const vectors = await this.computeEmbeddingsForFile(chunkOutput);
                if (vectors > 0) {
                    totalVectors += vectors;
                    totalFiles++;
                }
            }

            log(`Content index: Embedding progress: ${Math.min(i + batchSize, files.length)}/${files.length} files`);
        }

        await this.vectorCache?.save();

        const elapsed = Date.now() - startTime;
        log(`Content index: Embedding complete: ${totalVectors} vectors from ${totalChunks} chunks across ${totalFiles} files in ${elapsed}ms`);
    }

    /**
     * Filter out files whose content hasn't changed since their embeddings
     * were last computed. Compares the current file's SHA-256 hash against
     * the hash stored in the vector cache.
     *
     * @param files - Array of FileIndex instances to check
     * @returns Filtered array containing only files that need re-embedding
     */
    private async filterUnchangedFiles(files: FileIndex[]): Promise<FileIndex[]> {
        if (!this.vectorCache || files.length === 0) {
            return files;
        }

        const originalCount = files.length;
        const filtered: FileIndex[] = [];

        for (const fi of files) {
            const entry = this.vectorCache.getFileEntry(fi.getFilePath());
            if (entry) {
                try {
                    const buf = await fs.promises.readFile(fi.getFilePath());
                    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
                    if (sha256 === entry.sha256) {
                        continue; // unchanged — skip re-embedding
                    }
                } catch {
                    // File unreadable — include it so the error surfaces later
                }
            }
            filtered.push(fi);
        }

        return filtered;
    }

    /**
     * Compute and store embeddings for a single file's chunk output.
     * Filters out any failed embeddings (undefined slots from partial failures)
     * so that partial results are still cached.
     *
     * @param chunkOutput - The chunking result for a single file
     * @returns Number of vectors successfully stored
     */
    private async computeEmbeddingsForFile(
        chunkOutput: ComputeChunksOutput,
    ): Promise<number> {
        if (chunkOutput.error) {
            warn(`Content index: Chunk error for ${chunkOutput.filePath}: ${chunkOutput.error}`);
            return 0;
        }

        if (chunkOutput.chunks.length === 0) {
            return 0;
        }

        const chunks = chunkOutput.chunks;
        const texts = chunks.map(c => c.text);
        const vectors = await this.llamaServer!.embedBatch(texts);

        if (!vectors) {
            warn(`Content index: Failed to embed ${chunkOutput.filePath}`);
            return 0;
        }

        // Filter out any failed embeddings (undefined slots from partial failures)
        const validRanges = [];
        const validVectors = [];
        for (let i = 0; i < vectors.length; i++) {
            if (vectors[i]) {
                validRanges.push({
                    startLine: chunks[i].startLine,
                    endLine: chunks[i].endLine
                });
                validVectors.push(vectors[i]);
            }
        }

        if (validVectors.length < vectors.length) {
            warn(`Content index: ${vectors.length - validVectors.length}/${vectors.length} embeddings failed for ${chunkOutput.filePath}`);
        }

        if (validVectors.length > 0) {
            this.vectorCache?.add(chunkOutput.filePath, chunkOutput.sha256, validRanges, validVectors);
        }

        return validVectors.length;
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
        // Only add files with matching extensions
        const ext = path.extname(filePath).toLowerCase();
        const normalizedPath = this.normalizePath(filePath);
        if (!this.cache.has(normalizedPath) && this.fileExtensions.includes(ext)) {
            const fileIndex = new FileIndex(filePath, this.cacheDir);
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
     * @param includePaths - New list of directory paths to include
     * @param fileExtensions - New list of file extensions to include
     */
    updateConfig(includePaths: string[], fileExtensions: string[]): void {
        this.includePaths = includePaths;
        this.fileExtensions = fileExtensions.map(ext => ext.toLowerCase());
        this.rebuild();
    }

    /**
     * Get the current include paths configuration.
     */
    getIncludePaths(): string[] {
        return this.includePaths;
    }

    /**
     * Get the current file extensions configuration.
     */
    getFileExtensions(): string[] {
        return this.fileExtensions;
    }

    /**
     * Search the vector cache for the nearest embeddings to a query vector.
     * Splits work across all available CPU cores via the thread pool.
     *
     * @param queryVector - Embedding vector for the query (Float32Array of length `dims`)
     * @param topK - Maximum number of results to return
     * @returns Array of { filePath, startLine, endLine } ordered from most to least similar
     */
    async getNearestEmbeddings(
        queryVector: Float32Array,
        topK: number,
    ): Promise<NearestEmbeddingResult[]> {
        if (!this.vectorCache || !this.threadPool) {
            return [];
        }

        // Collect all live slot indices from every file in the vector cache
        // TODO: should this be a method in VectorCache?
        const allSlots: number[] = [];
        for (const filePath of this.vectorCache.getFilePaths()) {
            const entry = this.vectorCache.getFileEntry(filePath);
            if (!entry) continue;
            for (let i = 0; i < entry.ranges.length; i++) {
                allSlots.push(entry.startSlot + i);
            }
        }

        if (allSlots.length === 0) {
            return [];
        }

        // Split slots into consecutive groups, one per CPU core.
        // Consecutive assignment keeps each worker's slots closer together
        // in the SharedArrayBuffer, improving memory access locality.
        const numGroups = Math.min(os.cpus().length, allSlots.length);
        const baseSize = Math.floor(allSlots.length / numGroups);
        const remainder = allSlots.length % numGroups;
        const groups: number[][] = [];
        let offset = 0;
        for (let g = 0; g < numGroups; g++) {
            const size = baseSize + (g < remainder ? 1 : 0);
            groups.push(allSlots.slice(offset, offset + size));
            offset += size;
        }

        // Build a SearchEmbeddingsInput for each group, sharing the same SAB
        const sab = this.vectorCache.buffer;
        const dims = this.vectorCache.dims;
        const inputs: SearchEmbeddingsInput[] = groups.map(slots => ({
            type: 'searchEmbeddings' as const,
            vectors: sab,
            dims,
            queryVector,
            slots,
            topK,
        }));

        // Fan out to worker threads
        const outputs = await this.threadPool.searchEmbeddingsAll(inputs);

        // Merge results from all workers and pick the overall top-K
        const merged: { slot: number; score: number }[] = [];
        for (const output of outputs) {
            if (output.error) {
                warn(`Content index: Embedding search error: ${output.error}`);
                continue;
            }
            for (let i = 0; i < output.slots.length; i++) {
                merged.push({ slot: output.slots[i], score: output.scores[i] });
            }
        }

        merged.sort((a, b) => b.score - a.score);
        const topResults = merged.slice(0, topK);

        // Resolve each slot back to file path + line range
        const results: NearestEmbeddingResult[] = [];
        for (const { slot, score } of topResults) {
            const entry = this.vectorCache.getSlotEntry(slot);
            if (entry) {
                results.push({
                    filePath: entry.fileEntry.filePath,
                    startLine: entry.range.startLine,
                    endLine: entry.range.endLine,
                    score,
                });
            }
        }

        return results;
    }
}
