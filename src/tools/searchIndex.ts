// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as fs from 'fs';
import * as vscode from 'vscode';
import {
    ContentIndex,
    FileSearchResults,
    FileSymbols,
    DocumentType,
    SearchResult,
    IndexSymbol,
    AttrKey,
    symbolTypeToString,
    CALLABLE_TYPES
} from '../common/index';
import { log } from '../common/logger';
import { createMarkdownCodeBlock } from '../common/markdownUtils';
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
    /** When true, the query is treated as a single regex pattern instead of space-separated glob terms with AND semantics */
    isRegexp?: boolean;
    /** Number of context lines to show before and after each match. Context is bounded by enclosing code structure. Default is 0 (no context). */
    contextLines?: number;
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

function formatResultsForContainer(
    results: ResultWithContainer[]
): string {
    let markdown = '';
    const container = results[0].container;

    markdown += formatContainerHeading(container);

    for (const item of results) {
        markdown += `${item.result.line + 1}: ${item.result.text}\n`;
    }

    markdown += '\n';
    return markdown;
}

function formatResultsForContainerWithContext(
    results: ResultWithContainer[],
    fileLines: string[],
    filePath: string,
    fileSymbols: FileSymbols,
    numContextLines: number
): string {
    let markdown = '';
    const container = results[0].container;

    markdown += formatContainerHeading(container);

    // Build line ranges for each result, clamped to safe context bounds.
    const ranges: { start: number; end: number }[] = results.map(item => {
        const line = item.result.line;
        const { minLine, maxLine } = fileSymbols.getBoundsDelimitedBySymbols(line, fileLines.length);
        const start = Math.max(line - numContextLines, minLine);
        const end = Math.min(line + numContextLines, maxLine);
        return { start, end };
    });

    // Merge overlapping or adjacent ranges into sections.
    const sections: { start: number; end: number }[] = [];
    let current = ranges[0];
    for (let i = 1; i < ranges.length; i++) {
        if (ranges[i].start <= current.end + 1) {
            // Overlapping or adjacent — extend the current section
            current = {
                start: current.start,
                end: Math.max(current.end, ranges[i].end)
            };
        } else {
            sections.push(current);
            current = ranges[i];
        }
    }
    sections.push(current);

    // For CALLABLE containers, if the first section starts after
    // the container header end line, prepend the signature.
    if (container && CALLABLE_TYPES.has(container.type)) {
        const headerEndLine = container.attrs.get(AttrKey.ContainerHeaderEndLine);
        if (headerEndLine !== undefined && sections[0].start > headerEndLine) {
            const signature = container.attrs.get(AttrKey.Signature);
            if (signature) {
                markdown += `${signature}\n\n`;
            }
        }
    }

    // Render each section as a code block.
    for (const { start, end } of sections) {
        // Display 1-based line numbers in the prefix
        markdown += `Lines ${start + 1}-${end + 1}:\n`;
        const codeBlock = createMarkdownCodeBlock(
            fileLines,
            new vscode.Range(start, 0, end, 0),
            filePath
        );
        markdown += codeBlock.join('\n') + '\n\n';
    }

    return markdown;
}

/**
 * Format search results for a standard (non-knowledge-base) file,
 * grouped by container.
 *
 * @param fsr - File search results to format
 * @param fileSymbols - Parsed symbols for the file (for container lookup)
 * @param numContextLines - Number of context lines to show around each match
 * @returns Formatted Markdown string for this file's results
 */
async function formatResultsForFile(
    fsr: FileSearchResults,
    fileSymbols: FileSymbols | undefined,
    numContextLines: number
): Promise<string> {
    let markdown = '';

    // Resolve containers and build ResultWithContainer entries
    const resultsWithContainers: ResultWithContainer[] = fsr.results.map(result => ({
        result,
        container: fileSymbols?.getContainer(result.line) ?? null
    }));

    // Sort by line number
    resultsWithContainers.sort((a, b) => a.result.line - b.result.line);

    // Group results by container
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

    let fileLines: string[] | null = null;

    // Output results grouped by container
    for (const key of containerOrder) {
        const containerResults = byContainer.get(key)!;

        if (numContextLines > 1 && fileSymbols) {
            if (!fileLines) {
                try {
                    const content = await fs.promises.readFile(fsr.filePath, 'utf8');
                    fileLines = content.split('\n');
                } catch {
                    // If the file could not be read then fallback
                    // to formatting the results without context.
                    markdown += formatResultsForContainer(containerResults);
                    fileLines = null;
                    continue;
                }
            }

            markdown += formatResultsForContainerWithContext(
                containerResults,
                fileLines,
                fsr.filePath,
                fileSymbols,
                numContextLines);
        } else {
            markdown += formatResultsForContainer(containerResults);
        }
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
 * @param symbolsByFile - Map from file path to FileSymbols
 * @param query - Original search query
 * @param maxFileResults - Maximum number of files to show (0 or -1 for no limit)
 * @param numContextLines - Number of context lines to show around each match
 * @returns Formatted Markdown string
 */
async function formatResults(
    fileResults: FileSearchResults[],
    symbolsByFile: Map<string, FileSymbols>,
    query: string,
    maxFileResults: number,
    numContextLines: number = 0
): Promise<string> {
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
            markdown += await formatResultsForFile(
                fsr,
                symbolsByFile.get(fsr.filePath),
                numContextLines);
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
            const isRegexp = options.input.isRegexp ?? false;
            const searchResult = await contentIndex.getDocumentMatches(query, include, exclude, isRegexp, token);

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

            // Fetch symbols for standard (non-KB) files in a single batch call
            const standardFiles = fileResults.filter(f => f.docType !== DocumentType.KnowledgeBase);
            const uniqueStandardPaths = [...new Set(standardFiles.map(f => f.filePath))];
            const symbolsMap = await contentIndex.getSymbols(uniqueStandardPaths);

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
            const contextLines = options.input.contextLines ?? 0;

            // Format and return results
            const markdown = await formatResults(fileResults, symbolsMap, query, maxResults, contextLines);

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
