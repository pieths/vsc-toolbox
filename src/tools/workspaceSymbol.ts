// Copyright (c) 2025 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';

/**
 * Input parameters for workspace symbol search
 */
export interface IWorkspaceSymbolParams {
    query: string;
    filter?: string[];
}

/**
 * Workspace Symbol Tool - Search for symbols across the codebase
 * Uses VS Code's built-in workspace symbol provider
 */
export class WorkspaceSymbolTool implements vscode.LanguageModelTool<IWorkspaceSymbolParams> {
    constructor() { }

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
            // Use VS Code's built-in workspace symbol provider
            const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                'vscode.executeWorkspaceSymbolProvider',
                query
            );

            if (!symbols) {
                throw new Error('No symbols returned from workspace symbol provider.');
            }

            // Filter out symbols from generated mojom files
            let filteredSymbols = symbols.filter((symbol: vscode.SymbolInformation) => {
                return !symbol.location.uri.toString().includes('mojom');
            });

            // Apply optional filtering
            if (filter && filter.length > 0) {
                filteredSymbols = filteredSymbols.filter((symbol: vscode.SymbolInformation) => {
                    return filter.some((pattern: string) =>
                        symbol.location.uri.toString().includes(pattern)
                    );
                });
            }

            // Get source context for each symbol
            const symbolsWithContext = await Promise.all(
                filteredSymbols.map(async (s: vscode.SymbolInformation) => {
                    const sourceLine = await this.getSourceContextFromLocation(s.location, 0, 0);
                    const typeDetails = await this.getSymbolTypeDetails(s);
                    return {
                        name: s.name,
                        kind: vscode.SymbolKind[s.kind],
                        location: {
                            uri: s.location.uri.toString(),
                            line: s.location.range.start.line,
                            character: s.location.range.start.character,
                        },
                        containerName: s.containerName,
                        sourceLine: sourceLine,
                        typeDetails: typeDetails,
                    };
                })
            );

            const result = {
                query,
                totalResults: symbols.length,
                filteredResults: filteredSymbols.length,
                symbols: symbolsWithContext,
            };

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
            ]);
        } catch (error: any) {
            throw new Error(`Failed to search symbols: ${error.message}`);
        }
    }

    /**
     * Get source context from a location
     * @param location The location to get context from
     * @param numLinesBefore Number of lines before the location to include
     * @param numLinesAfter Number of lines after the location to include
     * @returns Array of source code lines
     */
    private async getSourceContextFromLocation(
        location: vscode.Location,
        numLinesBefore: number,
        numLinesAfter: number
    ): Promise<string[]> {
        try {
            const document = await vscode.workspace.openTextDocument(location.uri);
            const startLine = Math.max(0, location.range.start.line - numLinesBefore);
            const endLine = Math.min(document.lineCount - 1, location.range.start.line + numLinesAfter);

            const lines: string[] = [];
            for (let i = startLine; i <= endLine; i++) {
                lines.push(document.lineAt(i).text);
            }

            return lines;
        } catch (error: any) {
            return [`Error reading source: ${error.message}`];
        }
    }

    /**
     * Get type details for a symbol
     * @param symbolInfo The symbol information to get type details for
     * @returns String representing the type details, or undefined if not available
     */
    private async getSymbolTypeDetails(symbolInfo: vscode.SymbolInformation): Promise<string | undefined> {
        try {
            // Use hover provider to get rich type information
            const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
                'vscode.executeHoverProvider',
                symbolInfo.location.uri,
                symbolInfo.location.range.start
            );

            if (!hovers || hovers.length === 0) {
                return undefined;
            }

            // Extract text from the hover contents
            // Hover contents can be strings or MarkdownString objects
            const hoverTexts: string[] = [];
            for (const hover of hovers) {
                for (const content of hover.contents) {
                    if (typeof content === 'string') {
                        hoverTexts.push(content);
                    } else if (content instanceof vscode.MarkdownString) {
                        hoverTexts.push(content.value);
                    } else if ('value' in content) {
                        // MarkedString with value property
                        hoverTexts.push(content.value);
                    }
                }
            }

            // Join all hover text and return
            return hoverTexts.length > 0 ? hoverTexts.join('\n\n') : undefined;
        } catch (error: any) {
            return undefined;
        }
    }
}
