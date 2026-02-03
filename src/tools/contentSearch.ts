// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import { ContentIndex, SearchResult, ContainerDetails } from '../common/index';
import { log } from '../common/logger';

/**
 * Input parameters for the language model tool
 */
interface ContentSearchParams {
    /** Search query with space-separated OR terms and glob wildcards */
    query: string;
}

/**
 * Result with container information attached
 */
interface ResultWithContainer {
    result: SearchResult;
    container: ContainerDetails | null;
}

/**
 * Generate a unique key for a container (or top-level)
 */
function getContainerKey(container: ContainerDetails | null): string {
    if (!container) {
        return '__top_level__';
    }
    return `${container.fullyQualifiedName}:${container.startLine}-${container.endLine}`;
}

/**
 * Format a container heading line
 */
function formatContainerHeading(container: ContainerDetails | null): string {
    if (!container) {
        return '### (top-level)\n\n';
    }
    return `### (in ${container.ctagsType}) ${container.fullyQualifiedName} (lines ${container.startLine}-${container.endLine})\n\n`;
}

/**
 * Format search results as Markdown, grouped by file and container.
 *
 * @param resultsWithContainers - Array of search results with container info
 * @param query - Original search query
 * @returns Formatted Markdown string
 */
function formatResults(resultsWithContainers: ResultWithContainer[], query: string): string {
    if (resultsWithContainers.length === 0) {
        return `No matches found for: \`${query}\``;
    }

    // Group by file
    const byFile = new Map<string, ResultWithContainer[]>();
    for (const item of resultsWithContainers) {
        const existing = byFile.get(item.result.filePath) || [];
        existing.push(item);
        byFile.set(item.result.filePath, existing);
    }

    // Sort results within each file by line number
    for (const fileResults of byFile.values()) {
        fileResults.sort((a, b) => a.result.line - b.result.line);
    }

    let markdown = `# Search Results for \`${query}\`\n\n`;
    markdown += `Found **${resultsWithContainers.length}** matches in **${byFile.size}** files.\n\n`;

    for (const [filePath, fileResults] of byFile) {
        const relativePath = vscode.workspace.asRelativePath(filePath);
        markdown += `## ${relativePath}\n\n`;

        // Group results by container within this file
        const byContainer = new Map<string, ResultWithContainer[]>();
        const containerOrder: string[] = [];

        for (const item of fileResults) {
            const key = getContainerKey(item.container);
            if (!byContainer.has(key)) {
                byContainer.set(key, []);
                containerOrder.push(key);
            }
            byContainer.get(key)!.push(item);
        }

        // Output results grouped by container
        for (const key of containerOrder) {
            const containerResults = byContainer.get(key)!;
            const container = containerResults[0].container;

            markdown += formatContainerHeading(container);

            for (const item of containerResults) {
                const escapedText = item.result.text.replace(/`/g, '\\`');
                markdown += `- ${item.result.line}: \`${escapedText}\`\n`;
            }

            markdown += '\n';
        }
    }

    return markdown;
}

/**
 * ContentSearchTool is a VS Code Language Model Tool that provides
 * content search functionality using the ContentIndex.
 */
export class ContentSearchTool implements vscode.LanguageModelTool<ContentSearchParams> {
    constructor(_context: vscode.ExtensionContext) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ContentSearchParams>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const startTime = Date.now();
        const { query } = options.input;
        const contentIndex = ContentIndex.getInstance();

        // Check if index is ready
        if (!contentIndex.isReady()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    'Indexing in progress, please wait... ' +
                    'The content index is still building. ' +
                    'Try again in a few moments.'
                )
            ]);
        }

        try {
            // Check for cancellation
            if (token.isCancellationRequested) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('Search cancelled.')
                ]);
            }

            // Perform the search using ContentIndex
            const searchResult = await contentIndex.findGlobPattern(query, token);

            // Check for validation error
            if (searchResult.error) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Error: ${searchResult.error}`)
                ]);
            }

            const results = searchResult.results;

            // Check for cancellation
            if (token.isCancellationRequested) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('Search cancelled.')
                ]);
            }

            // Fetch container information for each result
            const resultsWithContainers: ResultWithContainer[] = await Promise.all(
                results.map(async (result) => {
                    const container = await contentIndex.getContainer(result.filePath, result.line);
                    return { result, container };
                })
            );

            // Check for cancellation
            if (token.isCancellationRequested) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('Search cancelled.')
                ]);
            }

            const elapsed = Date.now() - startTime;
            const fileCount = contentIndex.getFileCount();
            log(`Content search: Query "${query}" completed in ${elapsed}ms (${results.length} matches in ${fileCount} files)`);

            // Format and return results
            const markdown = formatResults(resultsWithContainers, query);

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
