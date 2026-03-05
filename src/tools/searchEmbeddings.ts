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
 * @param includeIds - Whether to include `<<RESULT_xxx>>` prefixes in section headings (for LLM re-ranking)
 * @returns Formatted Markdown string
 */
function formatResults(
    results: { embedding: NearestEmbeddingResult; lines: string[] }[],
    query: string,
    includeIds: boolean = false
): string {
    if (results.length === 0) {
        return `No matches found for: \`${query}\``;
    }

    let markdown = `${EMBEDDING_RESULTS_HEADER_PREFIX} \`${query}\`\n\n`;
    markdown += `Found **${results.length}** matches.\n\n`;

    for (let i = 0; i < results.length; i++) {
        const { embedding, lines } = results[i];
        const idPrefix = includeIds ? `<<RESULT_${String(i * 3).padStart(3, '0')}>> ` : '';
        markdown += `## ${idPrefix}${embedding.filePath} (score: ${embedding.score.toFixed(4)})\n\n`;
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

            // Apply LLM re-ranker if enabled
            const enableReranker = vscode.workspace.getConfiguration('vscToolbox')
                .get<boolean>('enableLlmReranker', false);

            let markdown: string;
            if (enableReranker) {
                // Format with IDs so the LLM can reference results by index
                const markdownWithIds = formatResults(resultsWithContent, query, true);
                const orderedIds = await this.applyLlmReranker(markdownWithIds, query, token, fileCache, resultsWithContent.length);
                // Reconstruct clean markdown from the selected/reordered subset
                const rerankedResults = orderedIds
                    .filter(id => id >= 0 && id < resultsWithContent.length)
                    .map(id => resultsWithContent[id]);
                markdown = formatResults(rerankedResults.length > 0 ? rerankedResults : resultsWithContent, query);
            } else {
                markdown = formatResults(resultsWithContent, query);
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
     * Returns an ordered array of result IDs (indices) that are relevant to the query.
     *
     * @param markdown The formatted embedding search results markdown (with IDs)
     * @param query The original search query
     * @param token Cancellation token
     * @param fileCache Cache for file contents
     * @param resultCount Total number of results
     * @returns Ordered array of result indices, most relevant first
     */
    private async applyLlmReranker(
        markdown: string,
        query: string,
        token: vscode.CancellationToken,
        fileCache: ScopedFileCache,
        resultCount: number
    ): Promise<number[]> {
        log(`Starting LLM re-ranker for query: "${query}"`);
        const rerankerStart = Date.now();
        const rerankerPrompt = [
            'You are a search result re-ranker.',
            'Each search result section below has a `<<RESULT_xxx>>` marker in its heading.',
            'Evaluate each result for its relevance to the query and return ONLY a JSON array of the relevant result markers,',
            'ordered from most relevant to least relevant. Omit any markers that are not relevant.',
            '',
            '# Instructions',
            '',
            '1. Examine each `## <<RESULT_xxx>>` section and determine if it is relevant to the query.',
            '2. Return ONLY a JSON array of result marker strings, e.g. `["RESULT_009", "RESULT_003", "RESULT_021"]`.',
            '3. Order the markers from most relevant to least relevant.',
            '4. Do NOT include any explanation, commentary, or additional text — just the JSON array.',
            '5. If the re-ranking requires information not currently present in the markdown, use the appropriate tool(s) to get the required information.',
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

        // Build a map of valid RESULT_xxx markers to array indices
        const markerToIndex = new Map<string, number>();
        for (let i = 0; i < resultCount; i++) {
            markerToIndex.set(`RESULT_${String(i * 3).padStart(3, '0')}`, i);
        }

        // Parse the JSON array of RESULT markers from the response
        try {
            // Extract the last JSON string array from the response to skip any thinking/reasoning arrays
            const matches = [...result.matchAll(/\[\s*"RESULT_\d{3}"(?:\s*,\s*"RESULT_\d{3}")*\s*\]/g)];
            const last = matches.at(-1);
            if (last) {
                const markers: string[] = JSON.parse(last[0]);
                // Validate: map to indices, filter invalid markers, and deduplicate
                const seen = new Set<number>();
                const unrecognized: string[] = [];
                const validIds: number[] = [];
                for (const marker of markers) {
                    const index = markerToIndex.get(marker);
                    if (index !== undefined && !seen.has(index)) {
                        seen.add(index);
                        validIds.push(index);
                    } else if (index === undefined) {
                        unrecognized.push(marker);
                    }
                }
                if (unrecognized.length > 0) {
                    log(`LLM re-ranker: unrecognized markers: [${unrecognized.join(', ')}]`);
                }
                log(`LLM re-ranker selected ${validIds.length} of ${resultCount} results: [${validIds.map(i => `RESULT_${String(i * 3).padStart(3, '0')}`).join(', ')}]`);
                return validIds;
            }
            log('LLM re-ranker: could not find JSON array in response, returning original order');
        } catch (err) {
            log(`LLM re-ranker: failed to parse response: ${err}`);
        }

        // Fallback: return all indices in original order
        return Array.from({ length: resultCount }, (_, i) => i);
    }
}
