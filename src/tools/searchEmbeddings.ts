// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import {
    ContentIndex,
    DocumentType,
    NearestEmbeddingResult,
    AttrKey,
    symbolTypeToString,
    CALLABLE_TYPES,
} from '../common/index';
import type { FileSymbols, IndexSymbol } from '../common/index';
import { sendLanguageModelRequest } from '../common/copilotUtils';
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
 * Format a container context line for an embedding result.
 * Returns an empty string when no context is needed (no container,
 * or the chunk already includes the container header).
 *
 * @param container - Innermost container symbol, or null
 * @param chunkStartLine - 1-based start line of the embedding chunk
 * @returns A single Markdown line (with trailing newlines) or empty string
 */
function formatContainerContext(
    container: IndexSymbol | null,
    chunkStartLine: number
): string {
    if (!container) {
        return '';
    }

    // If the chunk starts at or before the container's first line, the full
    // header is already visible in the code block — no extra context needed.
    // container.startLine is 0-based; chunkStartLine is 1-based.
    if ((chunkStartLine - 1) <= container.startLine) {
        return '';
    }

    const kind = symbolTypeToString(container.type);
    const label = CALLABLE_TYPES.has(container.type)
        ? (container.attrs.get(AttrKey.Signature) ?? container.attrs.get(AttrKey.FullyQualifiedName) ?? container.name)
        : (container.attrs.get(AttrKey.FullyQualifiedName) ?? container.name);

    return `Contained in [${kind}]: ${label} (lines ${container.startLine + 1}-${container.endLine + 1})\n\n`;
}

/**
 * A single embedding search result with its file content and optional container.
 */
interface ResultWithContext {
    embedding: NearestEmbeddingResult;
    lines: string[];
    container: IndexSymbol | null;
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
    results: ResultWithContext[],
    query: string,
    includeIds: boolean = false
): string {
    if (results.length === 0) {
        return `No matches found for: \`${query}\``;
    }

    let markdown = `${EMBEDDING_RESULTS_HEADER_PREFIX} \`${query}\`\n\n`;
    markdown += `Found **${results.length}** matches.\n\n`;

    for (let i = 0; i < results.length; i++) {
        const { embedding, lines, container } = results[i];
        const idPrefix = includeIds ? `<<RESULT_${String(i * 3).padStart(3, '0')}>> ` : '';
        markdown += `## ${idPrefix}${embedding.filePath} (score: ${embedding.score.toFixed(4)})\n\n`;
        markdown += formatContainerContext(container, embedding.startLine);
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
            // Fetch more results when re-ranker is enabled to give it a wider pool to filter from
            const enableReranker = vscode.workspace.getConfiguration('vscToolbox')
                .get<boolean>('enableLlmReranker', false);
            const searchLimit = enableReranker ? 50 : 30;
            const rawResults: NearestEmbeddingResult[] = await contentIndex.searchEmbeddings(query, searchLimit);

            if (token.isCancellationRequested) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('Search cancelled.')
                ]);
            }

            // Fetch file symbols for each result
            const uniquePaths = [...new Set(rawResults.map(r => r.filePath))];
            const symbolsMap = await contentIndex.getSymbols(uniquePaths);

            // Collapse knowledge base documents to a single overview-range result per file
            const collapsedResults = this.collapseKnowledgeBaseResults(rawResults, symbolsMap);

            // Merge overlapping results within the same file into single combined chunks
            const results = this.mergeOverlappingResults(collapsedResults);

            // Read file content for each result, caching files to avoid re-reads
            const fileCache = new ScopedFileCache();
            const resultsWithContext: ResultWithContext[] = [];
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
                    resultsWithContext.push({ embedding, lines, container: null });
                } catch {
                    // If we can't read the file, include the result with an error note
                    resultsWithContext.push({ embedding, lines: ['[unable to read file content]'], container: null });
                }
            }

            // Fetch container symbols for each result
            for (const item of resultsWithContext) {
                const fileSymbols = symbolsMap.get(item.embedding.filePath);
                if (fileSymbols) {
                    // embedding.startLine is 1-based; getContainer expects 0-based
                    item.container = fileSymbols.getContainer(item.embedding.startLine - 1);
                }
            }

            const elapsed = Date.now() - startTime;
            log(`Embedding search: Query "${query}" completed in ${elapsed}ms (${results.length} matches)`);

            // Apply LLM re-ranker if enabled
            let markdown: string;
            if (enableReranker) {
                // Format with IDs so the LLM can reference results by index
                const markdownWithIds = formatResults(resultsWithContext, query, true);
                const orderedIds = await this.applyLlmReranker(markdownWithIds, query, token, fileCache, resultsWithContext.length);
                // Reconstruct clean markdown from the selected/reordered subset
                const rerankedResults = orderedIds
                    .filter(id => id >= 0 && id < resultsWithContext.length)
                    .map(id => resultsWithContext[id]);
                markdown = formatResults(rerankedResults.length > 0 ? rerankedResults : resultsWithContext, query);
            } else {
                markdown = formatResults(resultsWithContext, query);
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
     * Collapse all embedding results for KnowledgeBase documents into a single
     * result per document whose range covers the Overview section.
     * Non-KnowledgeBase results pass through unchanged.
     *
     * Because the input results are already sorted by score descending, the
     * first hit for each KB file is guaranteed to have the highest score.
     * Subsequent hits for the same KB file are simply discarded.
     *
     * @param results - Embedding search results sorted by score descending
     * @param symbolsMap - Pre-fetched file symbols keyed by file path
     * @returns Results with KB documents collapsed to their overview ranges
     */
    private collapseKnowledgeBaseResults(
        results: NearestEmbeddingResult[],
        symbolsMap: Map<string, FileSymbols>
    ): NearestEmbeddingResult[] {
        const seenKbFiles = new Set<string>();
        const output: NearestEmbeddingResult[] = [];

        for (const r of results) {
            const fileSymbols = symbolsMap.get(r.filePath);
            if (fileSymbols?.docType === DocumentType.KnowledgeBase && fileSymbols.overviewRange) {
                if (seenKbFiles.has(r.filePath)) {
                    // Already emitted the overview for this KB doc — skip
                    continue;
                }
                seenKbFiles.add(r.filePath);
                output.push({
                    filePath: r.filePath,
                    // overviewRange is 0-based inclusive; convert to 1-based
                    startLine: fileSymbols.overviewRange.startLine + 1,
                    endLine: fileSymbols.overviewRange.endLine + 1,
                    score: r.score,
                });
            } else {
                output.push(r);
            }
        }

        return output;
    }

    /**
     * Merge overlapping embedding results within the same file into single
     * combined results. Two results overlap when they share at least one
     * common line (strictly adjacent ranges are kept separate). The merged
     * result spans the full union of lines and keeps the highest score from
     * the group. Results are returned sorted by score descending, matching
     * the original search-result ordering convention.
     *
     * @param results - Raw embedding search results (1-based inclusive line ranges)
     * @returns Deduplicated results with overlapping ranges merged
     */
    private mergeOverlappingResults(results: NearestEmbeddingResult[]): NearestEmbeddingResult[] {
        // Group results by file path
        const byFile = new Map<string, NearestEmbeddingResult[]>();
        for (const r of results) {
            let group = byFile.get(r.filePath);
            if (!group) {
                group = [];
                byFile.set(r.filePath, group);
            }
            group.push(r);
        }

        const merged: NearestEmbeddingResult[] = [];

        for (const [filePath, fileResults] of byFile) {
            // Sort by startLine so we can merge in a single pass
            fileResults.sort((a, b) => a.startLine - b.startLine);

            let curStart = fileResults[0].startLine;
            let curEnd = fileResults[0].endLine;
            let curScore = fileResults[0].score;

            for (let i = 1; i < fileResults.length; i++) {
                const r = fileResults[i];
                if (r.startLine <= curEnd) {
                    // Overlapping — extend the current range and keep the best score
                    curEnd = Math.max(curEnd, r.endLine);
                    curScore = Math.max(curScore, r.score);
                } else {
                    // No overlap — flush the current merged range
                    merged.push({ filePath, startLine: curStart, endLine: curEnd, score: curScore });
                    curStart = r.startLine;
                    curEnd = r.endLine;
                    curScore = r.score;
                }
            }
            // Flush the last range
            merged.push({ filePath, startLine: curStart, endLine: curEnd, score: curScore });
        }

        // Sort by score descending to preserve the "best match first" convention
        merged.sort((a, b) => b.score - a.score);
        return merged;
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
        const result = await sendLanguageModelRequest(null, rerankerPrompt, token, 1000, fileCache);
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
