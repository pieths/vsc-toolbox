// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import * as os from 'os';
import { CacheManager } from './cacheManager';
import { ThreadPoolManager } from './threadPool';
import { FileWatcher } from './fileWatcher';
import { parseQuery, validateQuery } from './queryParser';
import { SearchResult, FileSearchConfig, FileSearchParams, SearchInput } from './types';
import { log, warn, error } from '../../common/logger';

/**
 * Get the file search configuration from VS Code settings.
 *
 * @returns FileSearchConfig with worker threads and include paths
 */
function getConfig(): FileSearchConfig {
    const config = vscode.workspace.getConfiguration('vscToolbox.fileSearch');

    let workerThreads = config.get<number>('workerThreads', 0);
    if (workerThreads === 0) {
        workerThreads = os.cpus().length; // Auto-detect
    }

    const includePaths = config.get<string[]>('includePaths', []);
    const fileExtensions = config.get<string[]>('fileExtensions', ['.cc', '.h']);

    return { workerThreads, includePaths, fileExtensions };
}

/**
 * Format search results as Markdown.
 *
 * @param results - Array of search results
 * @param query - Original search query
 * @returns Formatted Markdown string
 */
function formatResults(results: SearchResult[], query: string): string {
    if (results.length === 0) {
        return `No matches found for: \`${query}\``;
    }

    // Group by file
    const byFile = new Map<string, SearchResult[]>();
    for (const result of results) {
        const existing = byFile.get(result.filePath) || [];
        existing.push(result);
        byFile.set(result.filePath, existing);
    }

    // Sort results within each file by line number
    for (const fileResults of byFile.values()) {
        fileResults.sort((a, b) => a.line - b.line);
    }

    let markdown = `## Search Results for \`${query}\`\n\n`;
    markdown += `Found **${results.length}** matches in **${byFile.size}** files.\n\n`;

    for (const [filePath, fileResults] of byFile) {
        const relativePath = vscode.workspace.asRelativePath(filePath);
        markdown += `### ${relativePath}\n\n`;

        for (const result of fileResults) {
            // Trim and escape backticks in the text
            const escapedText = result.text.trim().replace(/`/g, '\\`');
            markdown += `- ${result.line}: \`${escapedText}\`\n`;
        }

        markdown += '\n';
    }

    return markdown;
}

// Store the tool instance for testing
let fileSearchToolInstance: FileSearchTool | null = null;

/**
 * Get the file search tool instance for testing.
 * Returns null if the tool hasn't been registered yet.
 */
export function getFileSearchToolInstance(): FileSearchTool | null {
    return fileSearchToolInstance;
}

export class FileSearchTool implements vscode.LanguageModelTool<FileSearchParams> {
    private cacheManager: CacheManager;
    private threadPool: ThreadPoolManager;
    private fileWatcher: FileWatcher;

    constructor(context: vscode.ExtensionContext) {
        // Read configuration
        const { workerThreads, includePaths, fileExtensions } = getConfig();

        // Create status bar item for indexing progress
        const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBarItem.text = "$(sync~spin) VSC Toolbox: Indexing...";
        statusBarItem.tooltip = "VSC Toolbox: File Search tool is building its index";
        statusBarItem.show();

        // Create components
        this.cacheManager = new CacheManager();
        this.threadPool = new ThreadPoolManager(workerThreads);
        this.fileWatcher = new FileWatcher(this.cacheManager, this.threadPool, includePaths, fileExtensions);

        // Start background indexing using thread pool (non-blocking)
        this.cacheManager.initialize(includePaths, fileExtensions, this.threadPool).then(() => {
            const fileCount = this.cacheManager.getFileCount();
            // Hide status bar and show temporary notification
            statusBarItem.dispose();
            vscode.window.showInformationMessage(`VSC Toolbox: File Search: Indexed ${fileCount} files`);
            log('File search: Indexing complete');
        }).catch(err => {
            // Hide status bar and show error notification
            statusBarItem.dispose();
            vscode.window.showErrorMessage(`VSC Toolbox: File Search indexing failed: ${err}`);
            error(`File search: Indexing failed - ${err}`);
        });

        // Register for cleanup
        context.subscriptions.push({
            dispose: () => {
                this.fileWatcher.dispose();
                this.threadPool.dispose();
                statusBarItem.dispose();
            }
        });

        // Listen for configuration changes
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('vscToolbox.fileSearch')) {
                    const newConfig = getConfig();
                    this.cacheManager.updateConfig(newConfig.includePaths, newConfig.fileExtensions);
                    this.fileWatcher.updateConfig(newConfig.includePaths, newConfig.fileExtensions);
                    log('File search: Configuration updated');
                }
            })
        );

        // Store instance for testing
        fileSearchToolInstance = this;
        log('File search tool registered');
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<FileSearchParams>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { query } = options.input;

        // Validate query
        const validationError = validateQuery(query);
        if (validationError) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: ${validationError}`)
            ]);
        }

        // Check if cache is ready
        if (!this.cacheManager.isReady()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    'Indexing in progress, please wait... ' +
                    'The file search tool is still building its index. ' +
                    'Try again in a few moments.'
                )
            ]);
        }

        try {
            // Parse query to regex pattern
            const regexPattern = parseQuery(query);

            // Get all indexed files
            const allFiles = await this.cacheManager.getAllIndexed();

            if (allFiles.length === 0) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('No files are indexed. Check your includePaths configuration.')
                ]);
            }

            // Prepare search inputs
            const searchInputs: SearchInput[] = [];
            for (const fileIndex of allFiles) {
                const lineStarts = fileIndex.getLineStarts();
                if (lineStarts) {
                    searchInputs.push({
                        type: 'search',
                        filePath: fileIndex.getFilePath(),
                        regexPattern,
                        lineStarts
                    });
                }
            }

            // Check for cancellation
            if (token.isCancellationRequested) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('Search cancelled.')
                ]);
            }

            // Distribute search across worker threads
            const outputs = await this.threadPool.searchAll(searchInputs);

            // Check for cancellation
            if (token.isCancellationRequested) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('Search cancelled.')
                ]);
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
                warn(`File search: ${errors.length} files had errors`);
            }

            // Format and return results
            const markdown = formatResults(results, query);

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(markdown)
            ]);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Search error: ${message}`)
            ]);
        }
    }
}
