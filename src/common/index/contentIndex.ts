// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import * as os from 'os';
import { CacheManager } from './cacheManager';
import { ThreadPool } from './threadPool';
import { FileWatcher } from './fileWatcher';
import { parseQuery } from '../queryParser';
import { SearchResult, SearchResults, ContentIndexConfig, SearchInput, FunctionDetails, ContainerDetails } from './types';
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
    const ctagsPath = config.get<string>('ctagsPath', 'ctags');

    return { workerThreads, includePaths, fileExtensions, ctagsPath };
}

/**
 * ContentIndex is the public interface for accessing the content index functionality.
 * It provides a singleton pattern for easy access from other parts of the codebase.
 *
 * Usage:
 *   const index = ContentIndex.getInstance();
 *   const results = await index.findGlobPattern('myFunction*');
 */
export class ContentIndex {
    private static instance: ContentIndex | null = null;

    private cacheManager: CacheManager;
    private threadPool: ThreadPool | null = null;
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
        const { workerThreads, includePaths, fileExtensions, ctagsPath } = config;

        // Create status bar item for indexing progress
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.text = "$(sync~spin) VSC Toolbox: Indexing...";
        this.statusBarItem.tooltip = "VSC Toolbox: Content index is building";
        this.statusBarItem.show();

        // Create components
        this.threadPool = new ThreadPool(workerThreads);
        this.fileWatcher = new FileWatcher(this.cacheManager, includePaths, fileExtensions);

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
        this.cacheManager.initialize(includePaths, fileExtensions, ctagsPath, this.threadPool).then(() => {
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
     * Search for content matching a glob pattern query.
     * Validates the query, converts glob wildcards to regex, and performs the search.
     *
     * @param query - User search query with glob patterns (* and ?) and space-separated OR terms
     * @param token - Optional cancellation token
     * @returns SearchResults with results array and optional error
     */
    async findGlobPattern(query: string, token?: vscode.CancellationToken): Promise<SearchResults> {
        // Validate query is non-empty
        if (!query.trim()) {
            return { results: [], error: 'Search query cannot be empty' };
        }

        // Parse glob query to regex pattern
        const regexPattern = parseQuery(query);

        // Perform the search
        const results = await this.findRegexPattern(regexPattern, token);
        return { results };
    }

    /**
     * Search for content matching a regex pattern.
     * Internal method - use findGlobPattern for public API.
     *
     * @param regexPattern - Regex pattern string to search for
     * @param token - Optional cancellation token
     * @returns Array of search results
     */
    private async findRegexPattern(regexPattern: string, token?: vscode.CancellationToken): Promise<SearchResult[]> {
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
            // Get all files from cache
            const allFiles = await this.cacheManager.getAll();

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

    /**
     * Get detailed information about a function at a specific location.
     *
     * @param filePath - Absolute path to the source file
     * @param functionName - Name of the function to look up
     * @param line - 1-based line number where the function is defined
     * @returns FunctionDetails object, or null if not found or file not indexed
     */
    async getFunctionDetails(filePath: string, functionName: string, line: number): Promise<FunctionDetails | null> {
        if (!this.initialized) {
            warn('ContentIndex: Not initialized');
            return null;
        }

        if (!this.cacheManager.isReady()) {
            warn('ContentIndex: Index not ready');
            return null;
        }

        // Get the FileIndex for this file, ensuring it's valid
        const fileIndexMap = await this.cacheManager.get([filePath], true);
        const fileIndex = fileIndexMap.get(filePath);
        if (!fileIndex) {
            return null;  // File not in index or couldn't be indexed
        }

        return fileIndex.getFunctionDetails(functionName, line);
    }

    /**
     * Get the innermost container (function, class, namespace, etc.) at a specific line.
     *
     * @param filePath - Absolute path to the source file
     * @param line - 1-based line number to find the container for
     * @returns ContainerDetails object, or null if not found or file not indexed
     */
    async getContainer(filePath: string, line: number): Promise<ContainerDetails | null> {
        if (!this.initialized) {
            warn('ContentIndex: Not initialized');
            return null;
        }

        if (!this.cacheManager.isReady()) {
            warn('ContentIndex: Index not ready');
            return null;
        }

        // Get the FileIndex for this file, ensuring it's valid
        const fileIndexMap = await this.cacheManager.get([filePath], true);
        const fileIndex = fileIndexMap.get(filePath);
        if (!fileIndex) {
            return null;  // File not in index or couldn't be indexed
        }

        return fileIndex.getContainer(line);
    }

    /**
     * Get the fully qualified name for a symbol at a specific location.
     *
     * @param filePath - Absolute path to the source file
     * @param name - The symbol name to look up
     * @param location - The location of the symbol in the source file
     * @returns The fully qualified name (e.g., "namespace::Class::method") or the original name if not found
     */
    async getFullyQualifiedName(filePath: string, name: string, location: vscode.Location): Promise<string> {
        if (!this.initialized) {
            warn('ContentIndex: Not initialized');
            return name;
        }

        if (!this.cacheManager.isReady()) {
            warn('ContentIndex: Index not ready');
            return name;
        }

        // Get the FileIndex for this file, ensuring it's valid
        const fileIndexMap = await this.cacheManager.get([filePath], true);
        const fileIndex = fileIndexMap.get(filePath);
        if (!fileIndex) {
            return name;  // File not in index or couldn't be indexed
        }

        return fileIndex.getFullyQualifiedName(name, location);
    }
}
