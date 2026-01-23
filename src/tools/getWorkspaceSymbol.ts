// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import { createMarkdownCodeBlock } from '../common/markdownUtils';
import { getQualifiedNameFromSymbolInfo } from '../common/documentUtils';

/**
 * Input parameters for workspace symbol search
 */
export interface IWorkspaceSymbolParams {
    query: string;
    filter?: string[];
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
        const filterInfo = filter && filter.length > 0 ? ` filtered by: ${filter.join(', ')}` : '';

        return {
            invocationMessage: `Searching for symbol: "${query}"${filterInfo}`,
            confirmationMessages: {
                title: 'Search Workspace Symbols',
                message: new vscode.MarkdownString(
                    `Search for symbols matching **"${query}"** across the workspace?${filterInfo ? `\n\nFilters: \`${filter!.join('`, `')}\`` : ''}`
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IWorkspaceSymbolParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { query, filter } = options.input;

        try {
            // Split query by spaces and search for each part
            const queryParts = query.trim().split(/\s+/).filter(q => q.length > 0);

            let symbols: vscode.SymbolInformation[] = [];

            if (queryParts.length === 0) {
                throw new Error('No valid query provided.');
            }

            // Execute workspace symbol provider for each query part
            for (const queryPart of queryParts) {
                const partSymbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                    'vscode.executeWorkspaceSymbolProvider',
                    queryPart
                );

                if (partSymbols) {
                    symbols.push(...partSymbols);
                }
            }

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

            // Apply optional filtering
            if (filter && filter.length > 0) {
                filteredSymbols = filteredSymbols.filter((symbol: vscode.SymbolInformation) => {
                    return filter.some((pattern: string) =>
                        symbol.location.uri.toString().includes(pattern)
                    );
                });
            }

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
                    batch.map(s => this.convertSymbolToMarkdown(s))
                );
                markdownParts.push(...batchResults);
            }

            const markdown = markdownParts.join('\n');

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(markdown),
            ]);
        } catch (error: any) {
            throw new Error(`Failed to search symbols: ${error.message}`);
        }
    }

    /**
     * Convert a single symbol to markdown format
     * @param symbolInfo The symbol information from workspace symbol provider
     * @returns Markdown string for the symbol
     */
    private async convertSymbolToMarkdown(
        symbolInfo: vscode.SymbolInformation
    ): Promise<string> {
        const document = await vscode.workspace.openTextDocument(symbolInfo.location.uri);
        const lines: string[] = [];

        lines.push(`## Symbol: \`${symbolInfo.name}\``);
        lines.push('');

        // Add fully qualified name
        const qualifiedName = await getQualifiedNameFromSymbolInfo(symbolInfo);
        lines.push('**Full Name**: `' + qualifiedName + '`');
        lines.push('');

        lines.push('**Kind**: ' + vscode.SymbolKind[symbolInfo.kind]);
        lines.push('');

        // Add function signature for function-like symbols
        const kind = vscode.SymbolKind[symbolInfo.kind];
        const isFunctionLike = ['Function', 'Method', 'Constructor'].includes(kind);
        if (isFunctionLike) {
            lines.push('### Signature');
            lines.push('');
            const signatureRange = this.getFunctionSignatureRange(document, symbolInfo);
            lines.push(...createMarkdownCodeBlock(document, signatureRange));
            lines.push('');
        }

        lines.push('### Location');
        lines.push('');
        lines.push(`- **URI**: ${decodeURIComponent(symbolInfo.location.uri.toString())}`);
        lines.push(`- **Line**: ${symbolInfo.location.range.start.line + 1}`);
        lines.push(`- **Character**: ${symbolInfo.location.range.start.character + 1}`);
        lines.push('');
        lines.push('### `sourceLine` To Use For #get-document-symbol-references');
        lines.push('');

        // Create a single-line range for the symbol's starting line
        const singleLineRange = new vscode.Range(
            symbolInfo.location.range.start.line,
            0,
            symbolInfo.location.range.start.line,
            document.lineAt(symbolInfo.location.range.start.line).text.length
        );
        lines.push(...createMarkdownCodeBlock(document, singleLineRange));
        lines.push('');

        // Add comments section
        const comments = await this.getComments(document, symbolInfo);
        if (comments.length > 0) {
            lines.push('### Comments');
            lines.push('');
            lines.push(...comments);
            lines.push('');
        }

        return lines.join('\n');
    }

    /**
     * Get the range for a function signature by reading forward until ';' or '{'
     * @param document The text document
     * @param symbolInfo The symbol information
     * @returns Range covering the complete function signature
     */
    private getFunctionSignatureRange(
        document: vscode.TextDocument,
        symbolInfo: vscode.SymbolInformation
    ): vscode.Range {
        const startLine = symbolInfo.location.range.start.line;
        const startChar = symbolInfo.location.range.start.character;

        // Check if this is a C++ file
        const languageId = document.languageId;
        const isCpp = languageId === 'cpp' || languageId === 'c';

        // TODO: check to see if using document symbols would work better for
        // handling more complex signatures (i.e. return type on line above).
        // For C++, search forward until we find ';' or '{'
        if (isCpp) {
            for (let lineNum = startLine; lineNum < document.lineCount; lineNum++) {
                const lineText = document.lineAt(lineNum).text;
                const searchFrom = (lineNum === startLine) ? startChar : 0;

                // Look for ';' or '{' in this line
                for (let charIndex = searchFrom; charIndex < lineText.length; charIndex++) {
                    const char = lineText[charIndex];
                    if (char === ';' || char === '{') {
                        // Found the end - return range from start to this position (inclusive)
                        return new vscode.Range(
                            startLine,
                            startChar,
                            lineNum,
                            charIndex + 1
                        );
                    }
                }
            }
        }

        // For non-C++ languages or if we didn't find ';' or '{', return the original range
        return symbolInfo.location.range;
    }

    /**
     * Get comments immediately above the symbol, checking both current location and declarations
     * @param document The text document
     * @param symbolInfo The symbol information
     * @returns Array of comment lines
     */
    private async getComments(
        document: vscode.TextDocument,
        symbolInfo: vscode.SymbolInformation
    ): Promise<string[]> {
        const allComments: string[] = [];

        // Get comments from current location
        const currentCommentsRange = this.getCommentRangeBeforeLine(
            document,
            symbolInfo.location.range.start.line
        );
        if (currentCommentsRange) {
            allComments.push(...createMarkdownCodeBlock(document, currentCommentsRange));
        }

        // Try to find declarations in different files or locations
        try {
            const declarations = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeDeclarationProvider',
                symbolInfo.location.uri,
                symbolInfo.location.range.start
            );

            if (declarations && declarations.length > 0) {
                for (const declLocation of declarations) {
                    const declComments = await this.getCommentsFromAlternateLocation(
                        declLocation,
                        symbolInfo.location
                    );
                    if (declComments.length > 0) {
                        if (allComments.length > 0) {
                            allComments.push('');
                        }
                        allComments.push(...declComments);
                    }
                }
            }
        } catch (error) {
            // Declaration provider might not be available or might fail
            // Silently continue without declaration comments
        }

        return allComments;
    }

    /**
     * Get comments from a declaration location if it's different from the original location
     * @param declLocation The declaration location
     * @param originalLocation The original symbol location
     * @returns Array of comment markdown lines
     */
    private async getCommentsFromAlternateLocation(
        declLocation: vscode.Location,
        originalLocation: vscode.Location
    ): Promise<string[]> {
        // Only process if it's a different location (different file or different line)
        if (declLocation.uri.toString() === originalLocation.uri.toString() &&
            declLocation.range.start.line === originalLocation.range.start.line) {
            return [];
        }

        const declDocument = await vscode.workspace.openTextDocument(declLocation.uri);
        const declCommentsRange = this.getCommentRangeBeforeLine(
            declDocument,
            declLocation.range.start.line
        );

        if (declCommentsRange) {
            return createMarkdownCodeBlock(declDocument, declCommentsRange);
        }

        return [];
    }

    /**
     * Extract comment range immediately above a given line
     * @param document The text document
     * @param lineNumber The line number to check above
     * @returns Range covering the comment lines, or null if no comments found
     */
    private getCommentRangeBeforeLine(
        document: vscode.TextDocument,
        lineNumber: number
    ): vscode.Range | null {
        let commentStartLine: number | null = null;
        let commentEndLine: number | null = null;
        let inMultiLineComment = false;

        // Walk backwards from the line before the symbol
        for (let i = lineNumber - 1; i >= 0; i--) {
            const lineText = document.lineAt(i).text;
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
                document.lineAt(commentEndLine).text.length
            );
        }

        return null;
    }
}
