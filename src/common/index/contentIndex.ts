// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import * as os from 'os';
import { CacheManager } from './cacheManager';
import { ThreadPoolManager } from './threadPool';
import { FileWatcher } from './fileWatcher';
import { parseQuery } from './queryParser';
import { SearchResult, ContentIndexConfig, SearchInput } from './types';
import { log, warn, error } from '../logger';

/**
 * Get the content index configuration from VS Code settings.
 */
function getConfig(): ContentIndexConfig {
    const config = vscode.workspace.getConfiguration('vscToolbox.contentIndex');

    let workerThreads = config.get<number>('workerThreads', 0);
    if (workerThreads === 0) {
        workerThreads = os.cpus().length; // Auto-detect
    }

    const includePaths = config.get<string[]>('includePaths', []);
    const fileExtensions = config.get<string[]>('fileExtensions', ['.cc', '.h']);

    return { workerThreads, includePaths, fileExtensions };
}

/**
 * ContentIndex is the public interface for accessing the content index functionality.
 * It provides a singleton pattern for easy access from other parts of the codebase.
 *
 * Usage:
 *   const index = ContentIndex.getInstance();
 *   const results = await index.findPattern('myFunction*');
 */
export class ContentIndex {
    private static instance: ContentIndex | null = null;

    private cacheManager: CacheManager;
    private threadPool: ThreadPoolManager | null = null;
    private fileWatcher: FileWatcher | null = null;
    private statusBarItem: vscode.StatusBarItem | null = null;
    private initialized: boolean = false;
    private disposed: boolean = false;

    /**
     * Private constructor - use getInstance() instead.
     */
    private constructor() {
        this.cacheManager = new CacheManager();
    }

    /**
     * Get the singleton instance of ContentIndex.
     * Creates the instance if it doesn't exist.
     */
    static getInstance(): ContentIndex {
        if (!ContentIndex.instance) {
            ContentIndex.instance = new ContentIndex();
        }
        return ContentIndex.instance;
    }

    /**
     * Reset the singleton instance (useful for testing).
     */
    static resetInstance(): void {
        if (ContentIndex.instance) {
            ContentIndex.instance.dispose();
            ContentIndex.instance = null;
        }
    }

    /**
     * Initialize the file index system.
     * Reads configuration from VS Code settings, starts worker threads,
     * cache manager, and file watcher.
     * Returns immediately - indexing happens in the background.
     * Use isReady() to check if indexing is complete.
     *
     * @param context - VS Code extension context for registering disposables
     */
    initialize(context: vscode.ExtensionContext): void {
        if (this.initialized) {
            log('ContentIndex: Already initialized, skipping');
            return;
        }

        if (this.disposed) {
            error('ContentIndex: Cannot initialize a disposed instance');
            return;
        }

        this.initialized = true; // Mark as initialized immediately to prevent re-entry

        const config = getConfig();
        const { workerThreads, includePaths, fileExtensions } = config;

        // Create status bar item for indexing progress
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.text = "$(sync~spin) VSC Toolbox: Indexing...";
        this.statusBarItem.tooltip = "VSC Toolbox: Content index is building";
        this.statusBarItem.show();

        // Create components
        this.threadPool = new ThreadPoolManager(workerThreads);
        this.fileWatcher = new FileWatcher(this.cacheManager, this.threadPool, includePaths, fileExtensions);

        // Register for cleanup
        context.subscriptions.push({
            dispose: () => this.dispose()
        });

        // Listen for configuration changes
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('vscToolbox.contentIndex')) {
                    this.handleConfigChange();
                }
            })
        );

        // Start background indexing (fire-and-forget, non-blocking)
        this.cacheManager.initialize(includePaths, fileExtensions, this.threadPool).then(() => {
            const fileCount = this.cacheManager.getFileCount();
            // Hide status bar and show temporary notification
            this.statusBarItem?.dispose();
            this.statusBarItem = null;
            vscode.window.showInformationMessage(`VSC Toolbox: Content index: Indexed ${fileCount} files`);
            log('ContentIndex: Indexing complete');
        }).catch(err => {
            // Hide status bar and show error notification
            this.statusBarItem?.dispose();
            this.statusBarItem = null;
            vscode.window.showErrorMessage(`VSC Toolbox: Content index failed: ${err}`);
            error(`ContentIndex: Indexing failed - ${err}`);
        });
    }

    /**
     * Handle configuration changes.
     * Updates cache manager and file watcher with new settings.
     */
    private handleConfigChange(): void {
        const { includePaths, fileExtensions } = getConfig();

        this.cacheManager.updateConfig(includePaths, fileExtensions);
        this.fileWatcher?.updateConfig(includePaths, fileExtensions);
        log('ContentIndex: Configuration updated');
    }

    /**
     * Check if the index is ready for searches.
     *
     * @returns true if indexing is complete
     */
    isReady(): boolean {
        return this.initialized && this.cacheManager.isReady();
    }

    /**
     * Get the number of files currently indexed.
     *
     * @returns Number of indexed files
     */
    getFileCount(): number {
        return this.cacheManager.getFileCount();
    }

    /**
     * Search for files matching a regex pattern.
     *
     * @param regexPattern - Regex pattern string to search for
     * @param token - Optional cancellation token
     * @returns Array of search results
     */
    async findPattern(regexPattern: string, token?: vscode.CancellationToken): Promise<SearchResult[]> {
        if (!this.initialized || !this.threadPool) {
            warn('ContentIndex: Not initialized');
            return [];
        }

        if (!this.cacheManager.isReady()) {
            warn('ContentIndex: Index not ready');
            return [];
        }

        if (this.disposed) {
            warn('ContentIndex: Instance has been disposed');
            return [];
        }

        try {
            // Get all indexed files
            const allFiles = await this.cacheManager.getAllIndexed();

            if (allFiles.length === 0) {
                return [];
            }

            // Prepare search inputs
            const searchInputs: SearchInput[] = [];
            for (const fileIndex of allFiles) {
                searchInputs.push({
                    type: 'search',
                    filePath: fileIndex.getFilePath(),
                    regexPattern
                });
            }

            // Check for cancellation
            if (token?.isCancellationRequested) {
                return [];
            }

            // Distribute search across worker threads
            const outputs = await this.threadPool.searchAll(searchInputs);

            // Check for cancellation
            if (token?.isCancellationRequested) {
                return [];
            }

            // Collect results
            const results: SearchResult[] = [];
            const errors: string[] = [];

            for (const output of outputs) {
                if (output.error) {
                    errors.push(`${output.filePath}: ${output.error}`);
                } else {
                    for (const result of output.results) {
                        results.push({
                            line: result.line,
                            text: result.text,
                            filePath: output.filePath
                        });
                    }
                }
            }

            // Log any errors
            if (errors.length > 0) {
                warn(`ContentIndex: ${errors.length} files had errors`);
            }

            return results;
        } catch (err) {
            error(`ContentIndex: Search failed - ${err}`);
            return [];
        }
    }

    /**
     * Search for files matching a user query string.
     * Converts the query to a regex pattern using the query parser.
     *
     * @param query - User search query with glob wildcards
     * @param token - Optional cancellation token
     * @returns Array of search results
     */
    async findQuery(query: string, token?: vscode.CancellationToken): Promise<SearchResult[]> {
        const regexPattern = parseQuery(query);
        return this.findPattern(regexPattern, token);
    }

    /**
     * Clean up all resources.
     */
    dispose(): void {
        if (this.disposed) {
            return;
        }

        this.disposed = true;
        this.initialized = false;

        this.fileWatcher?.dispose();
        this.fileWatcher = null;

        this.threadPool?.dispose();
        this.threadPool = null;

        this.statusBarItem?.dispose();
        this.statusBarItem = null;

        log('ContentIndex: Disposed');
    }
}
