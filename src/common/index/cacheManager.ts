// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { FileIndex } from './fileIndex';
import { ThreadPoolManager } from './threadPool';
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
    private threadPool: ThreadPoolManager | null = null;

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
     * @param threadPool - Thread pool to use for parallel indexing
     */
    async initialize(includePaths: string[], fileExtensions: string[], threadPool: ThreadPoolManager): Promise<void> {
        this.includePaths = includePaths;
        this.fileExtensions = fileExtensions.map(ext => ext.toLowerCase());
        this.threadPool = threadPool;
        this.indexingComplete = false;

        log(`Content index: includePaths =\n${JSON.stringify(includePaths, null, 2)}`);
        log(`Content index: fileExtensions =\n${JSON.stringify(this.fileExtensions, null, 2)}`);

        this.indexingPromise = this.buildInitialIndex();
        await this.indexingPromise;
    }

    /**
     * Build the initial index for all matching files using worker threads.
     */
    private async buildInitialIndex(): Promise<void> {
        if (!this.threadPool) {
            error('CacheManager: Thread pool not initialized');
            this.indexingComplete = true;
            return;
        }

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

            // Scan each includePath directory for .cc and .h files
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

            log(`Content index: Total files to index: ${filePaths.length}`);

            // Process files in batches using worker threads
            // Larger batches since workers handle the actual I/O and CPU work
            const batchSize = 500;
            let lastYield = Date.now();

            for (let i = 0; i < filePaths.length; i += batchSize) {
                const batch = filePaths.slice(i, i + batchSize);

                // Send batch to worker threads for parallel indexing
                const results = await this.threadPool.indexAll(batch);

                // Process results and store in cache
                for (const result of results) {
                    const fileIndex = new FileIndex(result.filePath);

                    if (result.lineStarts) {
                        fileIndex.setLineStarts(result.lineStarts);
                    } else if (result.error) {
                        warn(`Failed to index file ${result.filePath}: ${result.error}`);
                    }

                    this.cache.set(this.normalizePath(result.filePath), fileIndex);
                }

                // Yield to event loop every 50ms to stay responsive
                const now = Date.now();
                if (now - lastYield > 50) {
                    await new Promise(resolve => setImmediate(resolve));
                    lastYield = Date.now();
                }
            }

            this.indexingComplete = true;
            log(`Content index: Indexed ${this.cache.size} files`);
        } catch (err) {
            error(`Failed to initialize file cache: ${err}`);
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
     * Get a FileIndex for a path.
     *
     * @param filePath - Absolute file path
     * @returns FileIndex instance or undefined if not in cache
     */
    get(filePath: string): FileIndex | undefined {
        return this.cache.get(this.normalizePath(filePath));
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
            const fileIndex = new FileIndex(filePath);
            this.cache.set(normalizedPath, fileIndex);

            // Build index in background using thread pool
            if (this.threadPool) {
                this.threadPool.submitIndex({ type: 'index', filePath }).then(result => {
                    if (result.lineStarts) {
                        fileIndex.setLineStarts(result.lineStarts);
                        log(`Content index: Indexed new file ${filePath}`);
                    } else if (result.error) {
                        warn(`Failed to index new file ${filePath}: ${result.error}`);
                    }
                }).catch(err => {
                    warn(`Failed to index new file ${filePath}: ${err}`);
                });
            }
        }
    }

    /**
     * Invalidate cache for a specific file.
     * The index will be rebuilt on next access.
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
     *
     * @param filePath - Absolute file path to remove
     */
    remove(filePath: string): void {
        this.cache.delete(this.normalizePath(filePath));
    }

    /**
     * Get all file paths in cache.
     *
     * @returns Array of absolute file paths
     */
    getAllPaths(): string[] {
        return Array.from(this.cache.keys());
    }

    /**
     * Get a FileIndex, ensuring it's indexed.
     * If not indexed, builds the index first.
     *
     * @param filePath - Absolute file path
     * @returns FileIndex instance or undefined if not in cache
     */
    async getIndexed(filePath: string): Promise<FileIndex | undefined> {
        const fileIndex = this.cache.get(this.normalizePath(filePath));
        if (fileIndex && !fileIndex.isIndexed() && this.threadPool) {
            try {
                const result = await this.threadPool.submitIndex({ type: 'index', filePath });
                if (result.lineStarts) {
                    fileIndex.setLineStarts(result.lineStarts);
                } else if (result.error) {
                    warn(`Failed to build index for ${filePath}: ${result.error}`);
                    return undefined;
                }
            } catch (err) {
                warn(`Failed to build index for ${filePath}: ${err}`);
                return undefined;
            }
        }
        return fileIndex;
    }

    /**
     * Get all FileIndex instances that are indexed and ready for search.
     *
     * @returns Array of indexed FileIndex instances
     */
    // TODO: this can be optimized.
    async getAllIndexed(): Promise<FileIndex[]> {
        const indexed: FileIndex[] = [];

        for (const fileIndex of this.cache.values()) {
            if (!fileIndex.isIndexed() && this.threadPool) {
                try {
                    const result = await this.threadPool.submitIndex({ type: 'index', filePath: fileIndex.getFilePath() });
                    if (result.lineStarts) {
                        fileIndex.setLineStarts(result.lineStarts);
                    } else if (result.error) {
                        warn(`Failed to build index for ${fileIndex.getFilePath()}: ${result.error}`);
                        continue;
                    }
                } catch (err) {
                    warn(`Failed to build index for ${fileIndex.getFilePath()}: ${err}`);
                    continue;
                }
            }
            indexed.push(fileIndex);
        }

        return indexed;
    }

    /**
     * Get the number of files in the cache.
     */
    size(): number {
        return this.cache.size;
    }

    /**
     * Clear cache and rebuild the index.
     * Called when configuration changes after initialization.
     */
    private rebuild(): void {
        this.cache.clear();
        this.indexingComplete = false;
        this.indexingPromise = this.buildInitialIndex();
    }

    /**
     * Update configuration and rebuild the index.
     * Triggers a full rebuild if already initialized.
     *
     * @param includePaths - New list of directory paths to include
     * @param fileExtensions - New list of file extensions to include
     */
    updateConfig(includePaths: string[], fileExtensions: string[]): void {
        this.includePaths = includePaths;
        this.fileExtensions = fileExtensions.map(ext => ext.toLowerCase());
        if (this.threadPool) {
            this.rebuild();
        }
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
