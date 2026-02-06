// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import picomatch from 'picomatch';
import { FileIndex } from './fileIndex';
import { ThreadPool } from './threadPool';
import { IndexInput } from './types';
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
     */
    async initialize(
        includePaths: string[],
        fileExtensions: string[],
        ctagsPath: string,
        threadPool: ThreadPool
    ): Promise<void> {
        this.includePaths = includePaths;
        this.fileExtensions = fileExtensions.map(ext => ext.toLowerCase());
        this.ctagsPath = ctagsPath;
        this.threadPool = threadPool;
        this.indexingComplete = false;

        // Compute cache directory once from first workspace folder
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        this.cacheDir = workspaceFolder
            ? path.join(workspaceFolder.uri.fsPath, '.cache', 'vsctoolbox', 'index')
            : '';

        // Ensure cache directory exists
        if (this.cacheDir) {
            await fs.promises.mkdir(this.cacheDir, { recursive: true });
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
        const elapsed = Date.now() - startTime;

        let successCount = 0;
        for (const output of outputs) {
            if (output.tagsPath && !output.error) {
                successCount++;
            }
        }

        if (successCount > 0) {
            log(`Content index: Indexed ${successCount} files in ${elapsed}ms`);
        }
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
            log(`Content index: Added new file ${filePath}`);
        }
    }

    /**
     * Invalidate cache for a specific file.
     * Cleans up any associated tags file.
     *
     * @param filePath - Absolute file path to invalidate
     */
    invalidate(filePath: string): void {
        const fileIndex = this.cache.get(this.normalizePath(filePath));
        if (fileIndex) {
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
}
