// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { CacheManager } from './cacheManager';
import { ThreadPool } from './workers/threadPool';
import { FileWatcher } from './fileWatcher';
import {
    ContentIndexConfig,
    DocumentType,
    FileSearchResults,
    NearestEmbeddingResult,
    SearchInput,
    SearchResults
} from './types';
import { FileSymbols } from './fileSymbols';
import { log, warn, error } from '../logger';
import { LlamaServer } from './embeddings/llamaServer';
import { PathFilter } from './pathFilter';

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
    const excludePatterns = config.get<string[]>('excludePatterns', []);
    const fileExtensions = config.get<string[]>('fileExtensions', ['.cc', '.h']);
    const enableEmbeddings = config.get<boolean>('enableEmbeddings', false);
    const knowledgeBaseDirectory = config.get<string>('knowledgeBaseDirectory', '').trim();

    return {
        workerThreads,
        includePaths,
        excludePatterns,
        fileExtensions,
        enableEmbeddings,
        knowledgeBaseDirectory
    };
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

    private context: vscode.ExtensionContext | null = null;
    private cacheManager: CacheManager;
    private threadPool: ThreadPool | null = null;
    private fileWatcher: FileWatcher | null = null;
    private llamaServer: LlamaServer;
    private pathFilter: PathFilter | null = null;
    private statusBarItem: vscode.StatusBarItem | null = null;
    private initialized: boolean = false;
    private disposed: boolean = false;
    private configChangeNotificationShown: boolean = false;

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
    static async resetInstance(): Promise<void> {
        if (ContentIndex.instance) {
            await ContentIndex.instance.dispose();
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

        this.context = context;

        // Register for cleanup (once)
        context.subscriptions.push({
            dispose: () => this.dispose()
        });

        // Listen for configuration changes (once)
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

        await this.startComponents();
    }

    /**
     * Create and start all owned components (cache manager, thread pool,
     * file watcher, llama server, path filter) and run initial indexing.
     * Called by initialize() on first startup and by reset() on restart.
     */
    private async startComponents(): Promise<void> {
        if (!this.context) {
            error('ContentIndex: No context available, cannot start components');
            return;
        }

        this.initialized = true; // Mark as initialized immediately to prevent re-entry

        try {
            const config = getConfig();
            const {
                workerThreads,
                includePaths,
                excludePatterns,
                fileExtensions,
                enableEmbeddings,
                knowledgeBaseDirectory
            } = config;

            // Create fresh components
            // (cacheManager and llamaServer are already fresh from the
            // constructor or from stopComponents if this is a reset)
            const nodePath = path.join(this.context.extensionPath, 'bin', 'win_x64', 'node', 'node.exe');
            this.threadPool = new ThreadPool(workerThreads, nodePath);
            this.pathFilter = new PathFilter(includePaths, excludePatterns, fileExtensions, knowledgeBaseDirectory);
            this.fileWatcher = new FileWatcher(this.cacheManager, this.pathFilter);

            // Initialize llama server for embeddings (if enabled)
            if (enableEmbeddings) {
                this.llamaServer.initialize(this.context);
                await this.llamaServer.start();
            }

            // Create status bar item for indexing progress
            this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
            this.statusBarItem.text = "$(sync~spin) VSC Toolbox: Indexing...";
            this.statusBarItem.tooltip = "VSC Toolbox: Content index is building";
            this.statusBarItem.show();

            // Start background indexing
            await this.cacheManager.initialize(
                this.pathFilter,
                this.threadPool,
                this.llamaServer,
                enableEmbeddings
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
     * Tear down all owned components without marking the instance as disposed.
     * Called by dispose() for final cleanup and by reset() before restarting.
     */
    private async stopComponents(): Promise<void> {
        this.initialized = false;

        this.fileWatcher?.dispose();
        this.fileWatcher = null;

        this.threadPool?.dispose();
        this.threadPool = null;

        this.llamaServer.stop();

        this.pathFilter = null;

        this.statusBarItem?.dispose();
        this.statusBarItem = null;

        // Dispose the old cache manager (closes vector database, etc.)
        // before replacing with a fresh instance
        await this.cacheManager.dispose();
        this.cacheManager = new CacheManager();

        log('ContentIndex: Components stopped');
    }

    /**
     * Tear down all components and rebuild the index from scratch.
     * Useful when a configuration change requires a full restart
     * (e.g., enabling/disabling embeddings).
     */
    private async reset(): Promise<void> {
        if (this.disposed) {
            warn('ContentIndex: Cannot reset a disposed instance');
            return;
        }

        log('ContentIndex: Resetting...');
        await this.stopComponents();
        await this.startComponents();
        log('ContentIndex: Reset complete');
    }

    /**
     * Handle configuration changes.
     * Shows a notification asking the user whether to restart the index.
     * Only one notification is shown at a time; subsequent changes while
     * a notification is visible are silently absorbed.
     */
    private handleConfigChange(): void {
        if (this.configChangeNotificationShown) {
            return; // Already showing a notification
        }

        this.configChangeNotificationShown = true;

        vscode.window.showInformationMessage(
            'VSC Toolbox: Content index settings have changed. Restart the index?',
            'Yes', 'No'
        ).then(selection => {
            this.configChangeNotificationShown = false;
            if (selection === 'Yes') {
                this.reset().catch(err => {
                    error(`ContentIndex: Reset after config change failed - ${err}`);
                });
            }
        });
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
     * @returns SearchResults with per-file results array and optional error
     */
    async getDocumentMatches(
        query: string,
        include?: string,
        exclude?: string,
        token?: vscode.CancellationToken
    ): Promise<SearchResults> {
        // Validate query is non-empty
        if (!query.trim()) {
            return { fileMatches: [], error: 'Search query cannot be empty' };
        }

        // Perform the search
        const fileMatches = await this.getDocumentMatchesInternal(query, include, exclude, token);
        return { fileMatches };
    }

    /**
     * Search for content matching a glob query.
     * Internal method - use getDocumentMatches for public API.
     *
     * Results are grouped per file. Markdown files whose first symbol is
     * a `# Overview` heading are tagged as {@link DocumentType.KnowledgeBase}
     * and include the heading's line extent in `overviewRange`.
     *
     * @param query - Glob query string (space-separated AND terms with * and ? wildcards)
     * @param include - Optional comma-separated glob patterns to include only matching file paths
     * @param exclude - Optional comma-separated glob patterns to exclude matching file paths
     * @param token - Optional cancellation token
     * @returns Array of per-file search results
     */
    private async getDocumentMatchesInternal(
        query: string,
        include?: string,
        exclude?: string,
        token?: vscode.CancellationToken
    ): Promise<FileSearchResults[]> {
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
                    query
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

            // Collect per-file results
            const fileResults: FileSearchResults[] = [];
            const errors: string[] = [];

            // Track markdown FileSearchResults directly for KB detection
            const mdFileResults: FileSearchResults[] = [];

            for (const output of outputs) {
                if (output.error) {
                    errors.push(`${output.filePath}: ${output.error}`);
                } else if (output.results.length > 0) {
                    const fsr: FileSearchResults = {
                        filePath: output.filePath,
                        docType: DocumentType.Standard,
                        results: output.results
                    };
                    fileResults.push(fsr);

                    if (output.filePath.endsWith('.md')) {
                        mdFileResults.push(fsr);
                    }
                }
            }

            // Detect knowledge base documents among markdown files
            if (mdFileResults.length > 0) {
                const mdFilePaths = mdFileResults.map(fsr => fsr.filePath);
                const symbolsMap = await this.cacheManager.getAllSymbols(mdFilePaths);

                for (const fsr of mdFileResults) {
                    const fileSymbols = symbolsMap.get(fsr.filePath);
                    if (fileSymbols && fileSymbols.docType === DocumentType.KnowledgeBase) {
                        fsr.docType = DocumentType.KnowledgeBase;
                        fsr.overviewRange = fileSymbols.overviewRange;
                    }
                }
            }

            // Log any errors
            if (errors.length > 0) {
                warn(`ContentIndex: ${errors.length} files had errors`);
            }

            return fileResults;
        } catch (err) {
            error(`ContentIndex: Search failed - ${err}`);
            return [];
        }
    }

    /**
     * Clean up all resources.
     */
    async dispose(): Promise<void> {
        if (this.disposed) {
            return;
        }

        this.disposed = true;
        await this.stopComponents();
        this.context = null;

        log('ContentIndex: Disposed');
    }

    /**
     * Get hydrated symbols for one or more files.
     *
     * @param filePaths - Array of absolute file paths to load symbols for
     * @returns Map of file path to FileSymbols (files not in the index or
     *          whose idx file cannot be read are silently omitted)
     */
    async getSymbols(filePaths: string[]): Promise<Map<string, FileSymbols>> {
        if (!this.initialized) {
            warn('ContentIndex: Not initialized');
            return new Map();
        }

        if (!this.cacheManager.isReady()) {
            warn('ContentIndex: Index not ready');
            return new Map();
        }

        return this.cacheManager.getAllSymbols(filePaths);
    }

    /**
     * Search the embedding index for text chunks most similar to a query string.
     *
     * @param query - Natural language or code query to search for
     * @param topK - Maximum number of results to return (default 50)
     * @returns Array of nearest embedding results ordered from most to least similar
     */
    async searchEmbeddings(query: string, topK: number = 50): Promise<NearestEmbeddingResult[]> {
        if (!this.initialized) {
            warn('ContentIndex: Not initialized');
            return [];
        }

        if (!this.cacheManager.isReady()) {
            warn('ContentIndex: Index not ready');
            return [];
        }

        if (!this.llamaServer.isReady()) {
            warn('ContentIndex: Llama server not ready');
            return [];
        }

        const prefixedQuery = this.llamaServer.getQueryPrefix() + query;
        const queryVector = await this.llamaServer.embed(prefixedQuery);
        if (!queryVector) {
            warn('ContentIndex: Failed to embed query');
            return [];
        }

        return this.cacheManager.getNearestEmbeddings(queryVector, topK);
    }
}
