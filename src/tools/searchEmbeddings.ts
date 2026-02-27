// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import { ContentIndex, NearestEmbeddingResult } from '../common/index';
import { sendRequestWithReadFileAccess } from '../common/copilotUtils';
import { log } from '../common/logger';
import { createMarkdownCodeBlock } from '../common/markdownUtils';
import { ScopedFileCache } from '../common/scopedFileCache';

/** Markdown header prefix used for embedding search results */
const EMBEDDING_RESULTS_HEADER_PREFIX = '# Embedding Search Results for';

/**
 * Input parameters for the SearchEmbeddings language model tool
 */
interface SearchEmbeddingsParams {
    /** Natural language or code query to search for */
    query: string;
}

/**
 * Format embedding search results as Markdown, preserving result order.
 *
 * @param results - Array of nearest embedding results with their file content
 * @param query - Original search query
 * @returns Formatted Markdown string
 */
function formatResults(
    results: { embedding: NearestEmbeddingResult; lines: string[] }[],
    query: string
): string {
    if (results.length === 0) {
        return `No matches found for: \`${query}\``;
    }

    let markdown = `${EMBEDDING_RESULTS_HEADER_PREFIX} \`${query}\`\n\n`;
    markdown += `Found **${results.length}** matches.\n\n`;

    for (const { embedding, lines } of results) {
        markdown += `## ${embedding.filePath} (score: ${embedding.score.toFixed(4)})\n\n`;
        markdown += `Showing lines ${embedding.startLine} - ${embedding.endLine}:\n\n`;
        const range = new vscode.Range(
            0, 0,
            lines.length - 1, 0
        );
        const codeBlock = createMarkdownCodeBlock(lines, range, embedding.filePath);
        markdown += codeBlock.join('\n') + '\n\n';
    }

    return markdown;
}

/**
 * SearchEmbeddingsTool is a VS Code Language Model Tool that provides
 * semantic embedding search functionality using the ContentIndex.
 */
export class SearchEmbeddingsTool implements vscode.LanguageModelTool<SearchEmbeddingsParams> {
    constructor(_context: vscode.ExtensionContext) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SearchEmbeddingsParams>,
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
            if (token.isCancellationRequested) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('Search cancelled.')
                ]);
            }

            // Perform the embedding search
            const results: NearestEmbeddingResult[] = await contentIndex.searchEmbeddings(query, 30);

            if (token.isCancellationRequested) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('Search cancelled.')
                ]);
            }

            // Read file content for each result, caching files to avoid re-reads
            const fileCache = new ScopedFileCache();
            const resultsWithContent: { embedding: NearestEmbeddingResult; lines: string[] }[] = [];
            for (const embedding of results) {
                if (token.isCancellationRequested) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart('Search cancelled.')
                    ]);
                }
                try {
                    const allLines = await fileCache.getLines(embedding.filePath);
                    // startLine and endLine are 1-based inclusive
                    const lines = allLines.slice(embedding.startLine - 1, embedding.endLine);
                    resultsWithContent.push({ embedding, lines });
                } catch {
                    // If we can't read the file, include the result with an error note
                    resultsWithContent.push({ embedding, lines: ['[unable to read file content]'] });
                }
            }

            const elapsed = Date.now() - startTime;
            log(`Embedding search: Query "${query}" completed in ${elapsed}ms (${results.length} matches)`);

            // Format and return results
            let markdown = formatResults(resultsWithContent, query);

            // Apply LLM re-ranker if enabled
            const enableReranker = vscode.workspace.getConfiguration('vscToolbox')
                .get<boolean>('enableLlmReranker', false);
            if (enableReranker) {
                markdown = await this.applyLlmReranker(markdown, query, token, fileCache);
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(markdown)
            ]);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Embedding search error: ${message}`)
            ]);
        }
    }

    /**
     * Apply an LLM-based re-ranker to the embedding search results.
     * Re-ranks and removes `## ` sections based on their relevance to the query.
     *
     * @param markdown The formatted embedding search results markdown
     * @param query The original search query
     * @param token Cancellation token
     * @param fileCache Cache for file contents
     * @returns The re-ranked and filtered markdown
     */
    private async applyLlmReranker(
        markdown: string,
        query: string,
        token: vscode.CancellationToken,
        fileCache: ScopedFileCache
    ): Promise<string> {
        log(`Starting LLM re-ranker for query: "${query}"`);
        const rerankerStart = Date.now();
        const rerankerPrompt = [
            'You are a search result re-ranker.',
            `Given the markdown below which contains embedding search results (starts with line \`${EMBEDDING_RESULTS_HEADER_PREFIX}\`),`,
            'evaluate each section for its relevance to the original search query.',
            '',
            '# Instructions',
            '',
            '1. Remove any `## ` sections that are NOT relevant to the query.',
            '2. Re-order the remaining `## ` sections so the most relevant results appear first.',
            '3. Return ONLY the filtered and re-ranked markdown with no additional commentary or explanation.',
            '4. Preserve the exact format and content of the remaining sections.',
            '5. Keep the top-level heading and summary line, updating the match count to reflect removals.',
            '6. If the re-ranking requires information not currently present in the markdown, use the appropriate tool(s) to get the required information.',
            '',
            '# Query',
            '',
            '```',
            query,
            '```',
            '',
            '',
            markdown
        ].join('\n');
        const result = await sendRequestWithReadFileAccess(null, rerankerPrompt, token, 1000, fileCache);
        const rerankerElapsed = Date.now() - rerankerStart;
        log(`LLM re-ranker completed in ${rerankerElapsed}ms`);

        // Strip any preamble the model may have added before the actual results
        const headerIndex = result.indexOf(EMBEDDING_RESULTS_HEADER_PREFIX);
        return headerIndex > 0 ? result.substring(headerIndex) : result;
    }
}
