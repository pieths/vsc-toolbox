// Copyright (c) 2025 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import { getQualifiedNameFromDocumentSymbol } from '../common/documentUtils';

/**
 * Get WinDbg Breakpoint Location Command - Creates WinDbg breakpoint strings
 */
export class GetWinDbgBreakpointLocationCommand {
    public readonly id = 'vscToolbox.getWinDbgBreakpointLocation';
    public readonly title = 'VSC Toolbox: Get WinDbg Breakpoint Location';

    constructor(private context: vscode.ExtensionContext) { }

    async execute(): Promise<void> {
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
            vscode.window.showWarningMessage('No active editor');
            return;
        }

        // Get the module name from settings
        const config = vscode.workspace.getConfiguration('vscToolbox');
        const moduleName = config.get<string>('windbgModuleName', 'chrome');

        if (!moduleName) {
            vscode.window.showErrorMessage('WinDbg module name not configured in settings');
            return;
        }

        // Prompt user to choose breakpoint type
        const choice = await vscode.window.showQuickPick(
            [
                { label: 'Method', description: 'Create breakpoint for current method' },
                { label: 'SourceLine', description: 'Create breakpoint for current source line' }
            ],
            { placeHolder: 'Select breakpoint type' }
        );

        if (!choice) {
            return; // User cancelled
        }

        let breakpointLocation: string;

        if (choice.label === 'Method') {
            breakpointLocation = await this.createMethodBreakpoint(editor, moduleName);
        } else {
            breakpointLocation = await this.createSourceLineBreakpoint(editor, moduleName);
        }

        if (breakpointLocation) {
            await vscode.env.clipboard.writeText(breakpointLocation);
            vscode.window.showInformationMessage(`Copied to clipboard: ${breakpointLocation}`);
        }
    }

    private async createMethodBreakpoint(editor: vscode.TextEditor, moduleName: string): Promise<string> {
        const position = editor.selection.active;
        const document = editor.document;

        try {
            // Get document symbols to find the current method
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                document.uri
            );

            if (!symbols || symbols.length === 0) {
                vscode.window.showWarningMessage('No symbols found in document');
                return '';
            }

            // Find the symbol at the cursor position
            const methodSymbol = this.findFunctionAtPosition(symbols, position);

            if (!methodSymbol) {
                vscode.window.showWarningMessage('Could not find method at cursor position');
                return '';
            }

            // Build the fully qualified method name
            const qualifiedName = getQualifiedNameFromDocumentSymbol(symbols, methodSymbol, position);

            return `${moduleName}!${qualifiedName}`;
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create method breakpoint: ${error}`);
            return '';
        }
    }

    private async createSourceLineBreakpoint(editor: vscode.TextEditor, moduleName: string): Promise<string> {
        const position = editor.selection.active;
        const filePath = editor.document.uri.fsPath;
        const lineNumber = position.line + 1; // Convert to 1-based line number

        // Convert forward slashes to double backslashes for WinDbg
        const windbgPath = filePath.replace(/\//g, '\\').replace(/\\/g, '\\\\');

        return `\`${moduleName}!${windbgPath}:${lineNumber}\``;
    }

    /**
     * Find the most specific symbol that is a method, function, or constructor
     * at the given position. Recursively searches through the symbol hierarchy
     * to find the deepest matching symbol.
     * @param symbols Array of document symbols to search through
     * @param position The position to find the symbol at
     * @returns The most specific method/function/constructor symbol at the position, or undefined if none found
     */
    private findFunctionAtPosition(
        symbols: vscode.DocumentSymbol[],
        position: vscode.Position
    ): vscode.DocumentSymbol | undefined {
        for (const symbol of symbols) {
            if (symbol.range.contains(position)) {
                // Check if a child symbol contains the position (more specific)
                if (symbol.children && symbol.children.length > 0) {
                    const childSymbol = this.findFunctionAtPosition(symbol.children, position);
                    if (childSymbol) {
                        return childSymbol;
                    }
                }

                // Return this symbol if it's a method/function
                if (symbol.kind === vscode.SymbolKind.Method ||
                    symbol.kind === vscode.SymbolKind.Function ||
                    symbol.kind === vscode.SymbolKind.Constructor) {
                    return symbol;
                }
            }
        }
        return undefined;
    }
}
