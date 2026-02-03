// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import { createMarkdownCodeBlock } from '../common/markdownUtils';
import { getFunctionSignatureRange } from '../common/documentUtils';
import { ScopedFileCache } from '../common/scopedFileCache';
import { ContentIndex } from '../common/index/contentIndex';
import { getModel, sendRequestWithReadFileAccess } from '../common/copilotUtils';
import { log } from '../common/logger';

/**
 * Input parameters for workspace symbol search
 */
export interface IWorkspaceSymbolParams {
    query: string;
    filter?: string;
}

/**
 * Get Workspace Symbol Tool - Search for symbols across the codebase
 * Uses VS Code's built-in workspace symbol provider
 */
export class GetWorkspaceSymbolTool implements vscode.LanguageModelTool<IWorkspaceSymbolParams> {
    constructor(_context: vscode.ExtensionContext) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IWorkspaceSymbolParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { query, filter } = options.input;
        const filterInfo = filter ? ` filtered by: ${filter}` : '';

        return {
            invocationMessage: `Searching for symbol: "${query}"${filterInfo}`,
            confirmationMessages: {
                title: 'Search Workspace Symbols',
                message: new vscode.MarkdownString(
                    `Search for symbols matching **"${query}"** across the workspace?${filterInfo ? `\n\nFilter: ${filter}` : ''}`
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IWorkspaceSymbolParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { query, filter } = options.input;

        // Create a file cache for this invocation to avoid repeated file reads
        const fileCache = new ScopedFileCache();

        try {
            // Split query by spaces and search for each part
            const queryParts = query.trim().split(/\s+/).filter(q => q.length > 0);

            let symbols: vscode.SymbolInformation[] = [];

            if (queryParts.length === 0) {
                throw new Error('No valid query provided.');
            }

            // Execute workspace symbol provider for each query part
            const symbolSearchStart = Date.now();
            for (const queryPart of queryParts) {
                const partSymbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                    'vscode.executeWorkspaceSymbolProvider',
                    queryPart
                );

                if (partSymbols) {
                    symbols.push(...partSymbols);
                }
            }
            const symbolSearchElapsed = Date.now() - symbolSearchStart;
            log(`Workspace symbol search took ${symbolSearchElapsed}ms for: ${queryParts.join(', ')}`);

            if (symbols.length === 0) {
                throw new Error('No symbols returned from workspace symbol provider.');
            }

            // Remove duplicate symbols (same name and location)
            const uniqueSymbols = new Map<string, vscode.SymbolInformation>();
            for (const symbol of symbols) {
                const key = `${symbol.name}|${symbol.location.uri.toString()}|${symbol.location.range.start.line}|${symbol.location.range.start.character}`;
                if (!uniqueSymbols.has(key)) {
                    uniqueSymbols.set(key, symbol);
                }
            }
            symbols = Array.from(uniqueSymbols.values());

            // Filter out symbols from generated or unwanted files
            // TODO: make this list configurable
            const excludePatterns = [/mojom/, /\.md$/, /depot_tools\/win_toolchain/];
            let filteredSymbols = symbols.filter((symbol: vscode.SymbolInformation) => {
                const uri = symbol.location.uri.toString();
                return !excludePatterns.some(pattern => pattern.test(uri));
            });

            // Sort symbols: exact matches first, then substring matches,
            // then fuzzy matches, preserving original order within each group.
            const exactMatches: vscode.SymbolInformation[] = [];
            const substringMatches: vscode.SymbolInformation[] = [];
            const fuzzyMatches: vscode.SymbolInformation[] = [];

            const queryLower = query.toLowerCase();

            for (const symbol of filteredSymbols) {
                const symbolNameLower = symbol.name.toLowerCase();

                if (symbolNameLower === queryLower) {
                    exactMatches.push(symbol);
                } else if (symbolNameLower.includes(queryLower)) {
                    substringMatches.push(symbol);
                } else {
                    fuzzyMatches.push(symbol);
                }
            }

            filteredSymbols = [...exactMatches, ...substringMatches, ...fuzzyMatches];

            const markdownParts: string[] = [];
            markdownParts.push(`# Symbol Matches for "${query}"`);
            markdownParts.push('');
            markdownParts.push(`- **Total Results:** ${symbols.length}`);
            markdownParts.push(`- **Filtered Results:** ${filteredSymbols.length}`);
            markdownParts.push('');

            // Process symbols in batches to improve performance
            const batchSize = 20;
            for (let i = 0; i < filteredSymbols.length; i += batchSize) {
                const batch = filteredSymbols.slice(i, i + batchSize);
                // Promise.all to process batch concurrently and in order
                // within each batch. batch.map starts all conversions,
                // then we await all of them to complete before moving
                // to the next batch.
                const batchResults = await Promise.all(
                    batch.map(s => this.convertSymbolToMarkdown(s, fileCache))
                );
                markdownParts.push(...batchResults);
            }

            const markdown = markdownParts.join('\n');

            // Filter results using AI if a filter is provided
            const model = await getModel();
            let filteredMarkdown = markdown;
            if (model && filter) {
                log(`Starting AI filter with criteria: "${filter}"`);
                const filterStart = Date.now();
                const filterPrompt = [
                    'You are a filter.',
                    'Given the markdown below which contains symbol search results (starts with line `# Symbol Matches for`),',
                    'apply the filter criteria from the "Filter" section below to keep or remove symbols as specified.',
                    'Return ONLY the filtered markdown with no additional commentary or explanation.',
                    'Preserve the exact format and content of the remaining text.',
                    'Do not add any additional text.',
                    'Only remove complete `## Symbol: ...` sections that don\'t satisfy the filter.',
                    'If removing a symbol section, remove the entire section including its header.',
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
                filteredMarkdown = await sendRequestWithReadFileAccess(model, filterPrompt, _token, 1000, fileCache);
                const filterElapsed = Date.now() - filterStart;
                log(`AI filter completed in ${filterElapsed}ms`);
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(filteredMarkdown),
            ]);
        } catch (error: any) {
            throw new Error(`Failed to search symbols: ${error.message}`);
        } finally {
            // Clear cache at the end of the invocation
            fileCache.clear();
        }
    }

    /**
     * Convert a single symbol to markdown format
     * @param symbolInfo The symbol information from workspace symbol provider
     * @param fileCache Cache for file contents
     * @returns Markdown string for the symbol
     */
    private async convertSymbolToMarkdown(
        symbolInfo: vscode.SymbolInformation,
        fileCache: ScopedFileCache
    ): Promise<string> {
        const filePath = symbolInfo.location.uri.fsPath;
        const fileLines = await fileCache.getLines(filePath);
        const markdownLines: string[] = [];

        markdownLines.push(`## Symbol: \`${symbolInfo.name}\``);
        markdownLines.push('');

        // Add fully qualified name
        const qualifiedName = await ContentIndex.getInstance().getFullyQualifiedName(
            filePath,
            symbolInfo.name,
            symbolInfo.location
        );
        markdownLines.push('**Full Name**: `' + qualifiedName + '`');
        markdownLines.push('');

        markdownLines.push('**Kind**: ' + vscode.SymbolKind[symbolInfo.kind]);
        markdownLines.push('');

        // Add function signature for function-like symbols
        const kind = vscode.SymbolKind[symbolInfo.kind];
        const isFunctionLike = ['Function', 'Method', 'Constructor'].includes(kind);
        if (isFunctionLike) {
            markdownLines.push('### Signature');
            markdownLines.push('');
            const signatureRange = getFunctionSignatureRange(fileLines, symbolInfo.location.range.start.line, symbolInfo.location.range.start.character);
            markdownLines.push(...createMarkdownCodeBlock(fileLines, signatureRange, filePath));
            markdownLines.push('');
        }

        markdownLines.push('### Location');
        markdownLines.push('');
        markdownLines.push(`- **URI**: ${decodeURIComponent(symbolInfo.location.uri.toString())}`);
        markdownLines.push(`- **Line**: ${symbolInfo.location.range.start.line + 1}`);
        markdownLines.push(`- **Character**: ${symbolInfo.location.range.start.character + 1}`);
        markdownLines.push('');
        markdownLines.push('### `sourceLine` To Use For #get-document-symbol-references');
        markdownLines.push('');

        // Create a single-line range for the symbol's starting line
        const startLine = symbolInfo.location.range.start.line;
        const singleLineRange = new vscode.Range(
            startLine,
            0,
            startLine,
            fileLines[startLine].length
        );
        markdownLines.push(...createMarkdownCodeBlock(fileLines, singleLineRange, filePath));
        markdownLines.push('');

        // Add comments section
        const comments = this.getComments(fileLines, symbolInfo.location.range.start.line);
        if (comments) {
            markdownLines.push('### Comments');
            markdownLines.push('');
            markdownLines.push(...createMarkdownCodeBlock(fileLines, comments, filePath));
            markdownLines.push('');
        }

        return markdownLines.join('\n');
    }

    /**
     * Get comments immediately above the symbol
     * @param lines The lines of the file
     * @param lineNumber The line number of the symbol (0-based)
     * @returns Range covering the comment lines, or null if no comments found
     */
    private getComments(
        lines: string[],
        lineNumber: number
    ): vscode.Range | null {
        let commentStartLine: number | null = null;
        let commentEndLine: number | null = null;
        let inMultiLineComment = false;

        // Walk backwards from the line before the symbol
        for (let i = lineNumber - 1; i >= 0; i--) {
            const lineText = lines[i];
            const trimmed = lineText.trim();

            if (trimmed.length === 0) {
                if (i == (lineNumber - 1)) {
                    // Comment must be directly above symbol
                    break;
                } else if (inMultiLineComment) {
                    // Empty line within multi-line comment, continue
                    continue;
                } else {
                    break;
                }
            }

            if (trimmed.startsWith('//')) {
                if (commentEndLine === null) {
                    commentEndLine = i;
                }
                commentStartLine = i;
                continue;
            }

            if (!inMultiLineComment && trimmed.endsWith('*/')) {
                if (trimmed.startsWith('/*')) {
                    // Found single line comment.
                    // Check for more comments above.
                    if (commentEndLine === null) {
                        commentEndLine = i;
                    }
                    commentStartLine = i;
                    continue;
                } else if (trimmed.includes('/*')) {
                    // Line contains something other than comment. Skip it.
                    // Handles cases like: int x; /* comment */
                    break;
                } else {
                    if (commentEndLine === null) {
                        commentEndLine = i;
                    }
                    commentStartLine = i;
                    inMultiLineComment = true;
                    continue;
                }
            }

            // If we're in a multi-line comment,
            // keep collecting until we find the start
            if (inMultiLineComment) {
                if (trimmed.includes('/*')) {
                    commentStartLine = i;
                    inMultiLineComment = false;
                }
                continue;
            }

            // Hit a non-comment line, stop searching
            break;
        }

        // Return range if we found comments
        if (commentStartLine !== null && commentEndLine !== null) {
            return new vscode.Range(
                commentStartLine,
                0,
                commentEndLine,
                lines[commentEndLine].length
            );
        }

        return null;
    }
}
