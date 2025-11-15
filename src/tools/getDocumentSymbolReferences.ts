// Copyright (c) 2025 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';

/**
 * Input parameters for finding references
 */
export interface ITextDocumentReferencesParams {
    uri: string;
    position: {
        line: number;
        character: number;
    };
    symbolName: string;
    sourceLine: string;
}

/**
 * Get Document Symbol References Tool - Find all references to a symbol
 * Uses VS Code's built-in reference provider
 */
export class GetDocumentSymbolReferencesTool implements vscode.LanguageModelTool<ITextDocumentReferencesParams> {
    constructor() { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ITextDocumentReferencesParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { uri, position, symbolName } = options.input;
        const fileName = uri.split('/').pop() || uri;

        return {
            invocationMessage: `Finding references to '${symbolName}' at ${fileName}:${position.line + 1}:${position.character + 1}`,
            confirmationMessages: {
                title: 'Find References',
                message: new vscode.MarkdownString(
                    `Find all references to the symbol **${symbolName}** at:\n\n` +
                    `- **File**: \`${fileName}\`\n` +
                    `- **Line**: ${position.line + 1}\n` +
                    `- **Column**: ${position.character + 1}`
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ITextDocumentReferencesParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { uri, position, symbolName, sourceLine } = options.input;

        try {
            // Parse the URI
            const parsedUri = vscode.Uri.parse(uri);

            // Open the document (VS Code will handle this internally)
            const document = await vscode.workspace.openTextDocument(parsedUri);

            // Get the exact position by verifying the source line and symbol
            const vscodePosition = await this.resolveExactPosition(
                document,
                position,
                symbolName,
                sourceLine
            );

            // Use VS Code's built-in command which handles language server communication
            // This works even for files that aren't open because VS Code manages it
            const references = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeReferenceProvider',
                document.uri,
                vscodePosition
            );

            if (!references) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(JSON.stringify({
                        uri,
                        position,
                        totalReferences: 0,
                        references: []
                    }, null, 2)),
                ]);
            }

            const result = {
                uri,
                position: {
                    line: vscodePosition.line,
                    character: vscodePosition.character,
                },
                symbolName: symbolName,
                sourceLine: sourceLine,
                totalReferences: references.length,
                references: await Promise.all(references.map(async (ref) => ({
                    uri: ref.uri.toString(),
                    range: {
                        start: {
                            line: ref.range.start.line,
                            character: ref.range.start.character,
                        },
                        end: {
                            line: ref.range.end.line,
                            character: ref.range.end.character,
                        },
                    },
                    sourceContext: await this.getSourceContextFromLocation(ref, 10, 10),
                }))),
            };

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
            ]);
        } catch (error: any) {
            throw new Error(`Failed to find references: ${error.message}. Verify the file URI and position are correct.`);
        }
    }

    /**
     * Resolve the exact position by matching the source line and finding the symbol
     * @param document The document to search in
     * @param position The approximate position
     * @param symbolName The name of the symbol to find
     * @param sourceLine The exact source line content
     * @returns The exact position of the symbol
     */
    private async resolveExactPosition(
        document: vscode.TextDocument,
        position: { line: number; character: number },
        symbolName: string,
        sourceLine: string
    ): Promise<vscode.Position> {
        // Search for the matching line within a reasonable range (±5 lines)
        const searchRange = 5;
        const startLine = Math.max(0, position.line - searchRange);
        const endLine = Math.min(document.lineCount - 1, position.line + searchRange);

        for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
            const line = document.lineAt(lineNum);

            // Check if this line matches the source line
            if (line.text.trim() === sourceLine.trim()) {
                // Found the matching line, now find the symbol within it
                const symbolIndex = line.text.indexOf(symbolName);

                if (symbolIndex !== -1) {
                    // Return the position at the start of the symbol
                    return new vscode.Position(lineNum, symbolIndex);
                }
            }
        }

        // If we couldn't find a match, fall back to the original position
        // but try to find the symbol on that line
        const fallbackLine = document.lineAt(Math.min(position.line, document.lineCount - 1));
        const symbolIndex = fallbackLine.text.indexOf(symbolName);

        if (symbolIndex !== -1) {
            return new vscode.Position(position.line, symbolIndex);
        }

        // Last resort: use the original position
        return new vscode.Position(position.line, position.character);
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

            // Get document symbols to find containing method/function
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                location.uri
            );

            // Find the containing method/function
            let methodRange: vscode.Range | undefined;
            if (symbols) {
                methodRange = this.findContainingMethod(symbols, location.range.start);
            }

            // Calculate start and end lines, constrained by method boundaries if found
            let startLine = Math.max(0, location.range.start.line - numLinesBefore);
            let endLine = Math.min(document.lineCount - 1, location.range.start.line + numLinesAfter);

            if (methodRange) {
                // Constrain to method boundaries
                startLine = Math.max(startLine, methodRange.start.line);
                endLine = Math.min(endLine, methodRange.end.line);
            }

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
     * Find the containing method/function for a position
     * @param symbols Document symbols to search
     * @param position Position to find container for
     * @returns Range of the containing method/function, or undefined if not found
     */
    private findContainingMethod(
        symbols: vscode.DocumentSymbol[],
        position: vscode.Position
    ): vscode.Range | undefined {
        for (const symbol of symbols) {
            // Check if this symbol contains the position
            if (symbol.range.contains(position)) {
                // Check if this is a method or function
                if (
                    symbol.kind === vscode.SymbolKind.Method ||
                    symbol.kind === vscode.SymbolKind.Function ||
                    symbol.kind === vscode.SymbolKind.Constructor
                ) {
                    return symbol.range;
                }

                // Recursively search children
                if (symbol.children && symbol.children.length > 0) {
                    const childResult = this.findContainingMethod(symbol.children, position);
                    if (childResult) {
                        return childResult;
                    }
                }

                // If we're in a class/namespace/etc but not in a method, check children
                if (symbol.children && symbol.children.length > 0) {
                    continue;
                }
            }
        }

        return undefined;
    }
}
