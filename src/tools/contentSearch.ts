// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import { ContentIndex, SearchResult } from '../common/index';
import { log } from '../common/logger';

/**
 * Input parameters for the language model tool
 */
interface ContentSearchParams {
    /** Search query with space-separated OR terms and glob wildcards */
    query: string;
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

            const elapsed = Date.now() - startTime;
            const fileCount = contentIndex.getFileCount();
            log(`Content search: Query "${query}" completed in ${elapsed}ms (${results.length} matches in ${fileCount} files)`);

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
