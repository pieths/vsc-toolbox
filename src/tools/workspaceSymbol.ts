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

            // Apply optional filtering
            let filteredSymbols = symbols;
            if (filter && filter.length > 0) {
                filteredSymbols = symbols.filter((symbol: vscode.SymbolInformation) => {
                    return filter.some((pattern: string) =>
                        symbol.location.uri.toString().includes(pattern)
                    );
                });
            }

            const result = {
                query,
                totalResults: symbols.length,
                filteredResults: filteredSymbols.length,
                symbols: filteredSymbols.map((s: vscode.SymbolInformation) => ({
                    name: s.name,
                    kind: vscode.SymbolKind[s.kind],
                    location: {
                        uri: s.location.uri.toString(),
                        line: s.location.range.start.line,
                        character: s.location.range.start.character,
                    },
                    containerName: s.containerName,
                })),
            };

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
            ]);
        } catch (error: any) {
            throw new Error(`Failed to search symbols: ${error.message}`);
        }
    }
}
