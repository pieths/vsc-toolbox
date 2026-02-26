// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as fs from 'fs';
import * as vscode from 'vscode';
import {
    ContentIndex,
    FileSearchResults,
    DocumentType,
    SearchResult,
    FileLineRef,
    IndexSymbol,
    AttrKey,
    symbolTypeToString
} from '../common/index';
import { log } from '../common/logger';
import { sendRequestWithReadFileAccess } from '../common/copilotUtils';

/**
 * Default maximum number of files to include in search results.
 * Use 0 or -1 for no limit.
 */
const DEFAULT_MAX_FILE_RESULTS = 15;

/** Markdown header prefix used for search results */
const SEARCH_RESULTS_HEADER_PREFIX = '# Search Results for';

/**
 * Input parameters for the language model tool
 */
interface SearchIndexParams {
    /** Search query with space-separated OR terms and glob wildcards */
    query: string;
    /** Optional comma-separated glob patterns to include only matching file paths */
    include?: string;
    /** Optional comma-separated glob patterns to exclude matching file paths */
    exclude?: string;
    /** Optional natural language filter to include or exclude results */
    filter?: string;
    /** Optional maximum number of files to include in results. Defaults to DEFAULT_MAX_FILE_RESULTS. Use 0 or -1 for no limit. */
    maxResults?: number;
}

/**
 * Result with container information attached
 */
interface ResultWithContainer {
    result: SearchResult;
    container: IndexSymbol | null;
}

/**
 * Generate a unique key for a container (or top-level)
 */
function getContainerKey(container: IndexSymbol | null): string {
    if (!container) {
        return '__top_level__';
    }
    const fqn = container.attrs.get(AttrKey.FullyQualifiedName) ?? container.name;
    return `${fqn}:${container.startLine}-${container.endLine}`;
}

/**
 * Format a container heading line
 */
function formatContainerHeading(container: IndexSymbol | null): string {
    if (!container) {
        return '### [top-level]\n\n';
    }
    const kind = symbolTypeToString(container.type);
    const fqn = container.attrs.get(AttrKey.FullyQualifiedName) ?? container.name;
    return `### [in ${kind}] ${fqn} (lines ${container.startLine + 1}-${container.endLine + 1})\n\n`;
}

/**
 * Format search results for a standard (non-knowledge-base) file,
 * grouped by container.
 *
 * @param resultsWithContainers - Line matches with their container symbols
 * @returns Formatted Markdown string for this file's results
 */
function formatResultsForFile(resultsWithContainers: ResultWithContainer[]): string {
    let markdown = '';

    // Group results by container within this file
    const byContainer = new Map<string, ResultWithContainer[]>();
    const containerOrder: string[] = [];

    for (const item of resultsWithContainers) {
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
            markdown += `${item.result.line + 1}: \`${escapedText}\`\n`;
        }

        markdown += '\n';
    }

    return markdown;
}

/**
 * Format search results for a knowledge base document.
 * Shows the full text of the Overview section instead of matched lines.
 *
 * @param fsr - The file search results (must be a KnowledgeBase document)
 * @returns Formatted Markdown string with the Overview section content
 */
function formatResultsForKnowledgeBaseDoc(fsr: FileSearchResults): string {
    if (!fsr.overviewRange) {
        // Shouldn't happen, but fall back gracefully
        return '*(Overview section not available)*\n\n';
    }

    const { startLine, endLine } = fsr.overviewRange;

    try {
        const content = fs.readFileSync(fsr.filePath, 'utf8');
        const lines = content.split('\n');
        const overviewLines = lines.slice(startLine, endLine + 1);
        const overviewText = overviewLines.join('\n').trimEnd();
        return overviewText + `\n\n*For more details, read: ${fsr.filePath}*\n\n`;
    } catch {
        return '*(Could not read Overview section)*\n\n';
    }
}

/**
 * Format search results as Markdown, grouped by file.
 * Standard files show matched lines grouped by container.
 * Knowledge base documents show the Overview section text.
 *
 * @param fileResults - Array of per-file search results
 * @param containersByFile - Map from file path to per-result containers
 * @param query - Original search query
 * @param maxFileResults - Maximum number of files to show (0 or -1 for no limit)
 * @returns Formatted Markdown string
 */
function formatResults(
    fileResults: FileSearchResults[],
    containersByFile: Map<string, (IndexSymbol | null)[]>,
    query: string,
    maxFileResults: number
): string {
    if (fileResults.length === 0) {
        return `No matches found for: \`${query}\``;
    }

    const totalFiles = fileResults.length;
    const totalMatches = fileResults.reduce((sum, f) => sum + f.results.length, 0);
    const hasLimit = maxFileResults > 0;
    const truncated = hasLimit && totalFiles > maxFileResults;

    let markdown = `${SEARCH_RESULTS_HEADER_PREFIX} \`${query}\`\n\n`;
    markdown += `Found **${totalMatches}** matches in **${totalFiles}** files.`;
    if (truncated) {
        markdown += ` Showing first **${maxFileResults}** files.`;
    }
    markdown += '\n\n';

    let filesShown = 0;
    for (const fsr of fileResults) {
        if (hasLimit && filesShown >= maxFileResults) {
            break;
        }
        filesShown++;

        markdown += `## ${fsr.filePath}\n\n`;

        if (fsr.docType === DocumentType.KnowledgeBase) {
            markdown += formatResultsForKnowledgeBaseDoc(fsr);
        } else {
            const containers = containersByFile.get(fsr.filePath) ?? [];
            const resultsWithContainers: ResultWithContainer[] = fsr.results.map((result, i) => ({
                result,
                container: containers[i] ?? null
            }));

            // Sort by line number
            resultsWithContainers.sort((a, b) => a.result.line - b.result.line);

            markdown += formatResultsForFile(resultsWithContainers);
        }
    }

    if (truncated) {
        const omittedFiles = totalFiles - maxFileResults;
        markdown += `---\n\n${omittedFiles} additional file(s) omitted. Use \`maxResults\` to increase the limit or set to 0 for no limit.\n`;
    }

    return markdown;
}

/**
 * SearchIndexTool is a VS Code Language Model Tool that provides
 * content search functionality using the ContentIndex.
 */
export class SearchIndexTool implements vscode.LanguageModelTool<SearchIndexParams> {
    constructor(_context: vscode.ExtensionContext) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SearchIndexParams>,
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
            const { include, exclude } = options.input;
            const searchResult = await contentIndex.getDocumentMatches(query, include, exclude, token);

            // Check for validation error
            if (searchResult.error) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Error: ${searchResult.error}`)
                ]);
            }

            const fileResults = searchResult.fileMatches;

            // Check for cancellation
            if (token.isCancellationRequested) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('Search cancelled.')
                ]);
            }

            // Fetch container information for standard (non-KB) files in a single batch call
            const standardFiles = fileResults.filter(f => f.docType !== DocumentType.KnowledgeBase);
            const fileLineRefs: FileLineRef[] = [];
            for (const fsr of standardFiles) {
                for (const r of fsr.results) {
                    fileLineRefs.push({ filePath: fsr.filePath, line: r.line });
                }
            }
            const allContainers = await contentIndex.getContainers(fileLineRefs);

            // Build a map from file path → per-result containers
            const containersByFile = new Map<string, (IndexSymbol | null)[]>();
            let containerIdx = 0;
            for (const fsr of standardFiles) {
                const fileContainers: (IndexSymbol | null)[] = [];
                for (let i = 0; i < fsr.results.length; i++) {
                    fileContainers.push(allContainers[containerIdx++]);
                }
                containersByFile.set(fsr.filePath, fileContainers);
            }

            // Check for cancellation
            if (token.isCancellationRequested) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('Search cancelled.')
                ]);
            }

            const totalMatches = fileResults.reduce((sum, f) => sum + f.results.length, 0);
            const elapsed = Date.now() - startTime;
            const fileCount = contentIndex.getFileCount();
            log(`Content search: Query "${query}" completed in ${elapsed}ms (${totalMatches} matches in ${fileCount} files)`);

            // Resolve maxResults: use provided value or fall back to default
            const maxResults = options.input.maxResults ?? DEFAULT_MAX_FILE_RESULTS;

            // Format and return results
            const markdown = formatResults(fileResults, containersByFile, query, maxResults);

            // Filter results using AI if a filter is provided
            const { filter } = options.input;
            const filteredMarkdown = filter
                ? await this.applyAIFilter(markdown, filter, token)
                : markdown;

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(filteredMarkdown)
            ]);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Search error: ${message}`)
            ]);
        }
    }

    /**
     * Apply an AI-based filter to the search results markdown.
     * Uses the default cached language model.
     *
     * @param markdown The full search results markdown
     * @param filter The filter criteria to apply
     * @param token Cancellation token
     * @returns The filtered markdown
     */
    private async applyAIFilter(
        markdown: string,
        filter: string,
        token: vscode.CancellationToken
    ): Promise<string> {
        log(`Starting AI filter with criteria: "${filter}"`);
        const filterStart = Date.now();
        const filterPrompt = [
            'You are a filter.',
            `Given the markdown below which contains search results (starts with line \`${SEARCH_RESULTS_HEADER_PREFIX}\`),`,
            'apply the filter criteria from the "Filter" section below to keep or remove results as specified.',
            'Return ONLY the filtered markdown with no additional commentary or explanation.',
            'Preserve the exact format and content of the remaining text.',
            'Do not add any additional text.',
            'Only remove complete sections (starting with `## ` or `### `) or individual result lines that don\'t satisfy the filter.',
            'If removing a full section, remove the entire section including its header.',
            'If the filter criteria requires information not currently present in the markdown, use the appropriate tool(s) to get the required information.',
            '',
            '# Filter',
            '',
            '```',
            filter,
            '```',
            '',
            '',
            markdown
        ].join('\n');
        const result = await sendRequestWithReadFileAccess(null, filterPrompt, token, 1000);
        const filterElapsed = Date.now() - filterStart;
        log(`AI filter completed in ${filterElapsed}ms`);

        // Strip any preamble the model may have added before the actual results
        const headerIndex = result.indexOf(SEARCH_RESULTS_HEADER_PREFIX);
        return headerIndex > 0 ? result.substring(headerIndex) : result;
    }
}
