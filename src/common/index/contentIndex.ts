// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import * as os from 'os';
import { CacheManager } from './cacheManager';
import { ThreadPool } from './threadPool';
import { FileWatcher } from './fileWatcher';
import { parseQueryAsAnd } from '../queryParser';
import {
    ContainerDetails,
    ContentIndexConfig,
    FileLineRef,
    FunctionDetails,
    SearchInput,
    SearchResult,
    SearchResults
} from './types';
import { log, warn, error } from '../logger';
import { LlamaServer } from './llamaServer';

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
 *   const results = await index.getDocumentMatches('myFunction*');
 */
export class ContentIndex {
    private static instance: ContentIndex | null = null;

    private cacheManager: CacheManager;
    private threadPool: ThreadPool | null = null;
    private fileWatcher: FileWatcher | null = null;
    private llamaServer: LlamaServer;
    private statusBarItem: vscode.StatusBarItem | null = null;
    private initialized: boolean = false;
    private disposed: boolean = false;

    /**
     * Private constructor - use getInstance() instead.
     */
    private constructor() {
        this.cacheManager = new CacheManager();
        this.llamaServer = new LlamaServer();
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
     * cache manager, llama server and file watcher.
     * Returns immediately - indexing happens in the background.
     * Use isReady() to check if indexing is complete.
     *
     * @param context - VS Code extension context for registering disposables
     */
    async initialize(context: vscode.ExtensionContext): Promise<void> {
        if (this.initialized) {
            log('ContentIndex: Already initialized, skipping');
            return;
        }

        if (this.disposed) {
            error('ContentIndex: Cannot initialize a disposed instance');
            return;
        }

        this.initialized = true; // Mark as initialized immediately to prevent re-entry

        try {
            const config = getConfig();
            const { workerThreads, includePaths, fileExtensions, ctagsPath } = config;

            // Create components
            this.threadPool = new ThreadPool(workerThreads);
            this.fileWatcher = new FileWatcher(this.cacheManager, includePaths, fileExtensions);

            // Initialize llama server for embeddings
            this.llamaServer.initialize(context);
            await this.llamaServer.start();

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

            // Wait briefly before indexing to allow VS Code and other extensions
            // to finish any post-startup file modifications that would trigger
            // unnecessary re-indexing (e.g., formatOnSave, insertFinalNewline).
            await new Promise(resolve => setTimeout(resolve, 10000));

            // Create status bar item for indexing progress
            this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
            this.statusBarItem.text = "$(sync~spin) VSC Toolbox: Indexing...";
            this.statusBarItem.tooltip = "VSC Toolbox: Content index is building";
            this.statusBarItem.show();

            // Start background indexing
            await this.cacheManager.initialize(
                includePaths,
                fileExtensions,
                ctagsPath,
                this.threadPool,
                this.llamaServer
            );

            const fileCount = this.cacheManager.getFileCount();
            this.statusBarItem?.dispose();
            this.statusBarItem = null;
            vscode.window.showInformationMessage(`VSC Toolbox: Content index: Indexed ${fileCount} files`);
            log('ContentIndex: Indexing complete');
        } catch (err) {
            this.statusBarItem?.dispose();
            this.statusBarItem = null;
            vscode.window.showErrorMessage(`VSC Toolbox: Content index failed: ${err}`);
            error(`ContentIndex: Indexing failed - ${err}`);
        }
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
     *
     * @param query - User search query with glob patterns (* and ?) and space-separated AND terms
     * @param include - Optional comma-separated glob patterns to include only matching file paths
     * @param exclude - Optional comma-separated glob patterns to exclude matching file paths
     * @param token - Optional cancellation token
     * @returns SearchResults with results array and optional error
     */
    async getDocumentMatches(
        query: string,
        include?: string,
        exclude?: string,
        token?: vscode.CancellationToken
    ): Promise<SearchResults> {
        // Validate query is non-empty
        if (!query.trim()) {
            return { results: [], error: 'Search query cannot be empty' };
        }

        // Parse glob query to regex pattern
        const regexPatterns = parseQueryAsAnd(query);

        // Perform the search
        const results = await this.getDocumentMatchesInternal(regexPatterns, include, exclude, token);
        return { results };
    }

    /**
     * Search for content matching regex patterns.
     * Internal method - use getDocumentMatches for public API.
     *
     * @param regexPatterns - Array of regex pattern strings to search for
     * @param include - Optional comma-separated glob patterns to include only matching file paths
     * @param exclude - Optional comma-separated glob patterns to exclude matching file paths
     * @param token - Optional cancellation token
     * @returns Array of search results
     */
    private async getDocumentMatchesInternal(
        regexPatterns: string[],
        include?: string,
        exclude?: string,
        token?: vscode.CancellationToken
    ): Promise<SearchResult[]> {
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
            // Get all files from cache, filtered by include/exclude glob patterns
            const allFiles = this.cacheManager.getAllPaths(include, exclude);

            if (allFiles.length === 0) {
                return [];
            }

            // Prepare search inputs
            const searchInputs: SearchInput[] = [];
            for (const filePath of allFiles) {
                searchInputs.push({
                    type: 'search',
                    filePath,
                    regexPatterns
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

        this.llamaServer.stop();

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
     * Get the innermost container (function, class, namespace, etc.) for multiple locations.
     *
     * @param queries - Array of FileLineRef objects to look up
     * @returns Array of ContainerDetails (or null) in the same order as input queries
     */
    async getContainers(queries: FileLineRef[]): Promise<(ContainerDetails | null)[]> {
        if (!this.initialized) {
            warn('ContentIndex: Not initialized');
            return queries.map(() => null);
        }

        if (!this.cacheManager.isReady()) {
            warn('ContentIndex: Index not ready');
            return queries.map(() => null);
        }

        if (queries.length === 0) {
            return [];
        }

        const uniqueFilePaths = [...new Set(queries.map(q => q.filePath))];
        const fileIndexMap = await this.cacheManager.get(uniqueFilePaths, true);

        // Group queries by file path, tracking original indices
        const queriesByFile = new Map<string, Array<{ originalIndex: number; line: number }>>();
        queries.forEach((query, index) => {
            const existing = queriesByFile.get(query.filePath) || [];
            existing.push({ originalIndex: index, line: query.line });
            queriesByFile.set(query.filePath, existing);
        });

        // Pre-allocate results array (maintains input order)
        const results: (ContainerDetails | null)[] = new Array(queries.length).fill(null);

        // Process each file's queries consecutively (keeps FileIndex cache hot)
        for (const [filePath, fileQueries] of queriesByFile) {
            const fileIndex = fileIndexMap.get(filePath);
            if (fileIndex) {
                for (const { originalIndex, line } of fileQueries) {
                    results[originalIndex] = await fileIndex.getContainer(line);
                }
            }
        }

        return results;
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
