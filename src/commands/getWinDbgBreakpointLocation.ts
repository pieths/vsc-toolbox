// Copyright (c) 2025 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';

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
            const methodSymbol = this.findSymbolAtPosition(symbols, position);

            if (!methodSymbol) {
                vscode.window.showWarningMessage('Could not find method at cursor position');
                return '';
            }

            // Build the fully qualified method name
            const qualifiedName = this.buildQualifiedName(symbols, methodSymbol, position);

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

    private findSymbolAtPosition(
        symbols: vscode.DocumentSymbol[],
        position: vscode.Position
    ): vscode.DocumentSymbol | undefined {
        for (const symbol of symbols) {
            if (symbol.range.contains(position)) {
                // Check if a child symbol contains the position (more specific)
                if (symbol.children && symbol.children.length > 0) {
                    const childSymbol = this.findSymbolAtPosition(symbol.children, position);
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

    private buildQualifiedName(
        symbols: vscode.DocumentSymbol[],
        targetSymbol: vscode.DocumentSymbol,
        position: vscode.Position
    ): string {
        const parts: string[] = [];

        // Build the hierarchy by finding parent symbols
        this.buildNameHierarchy(symbols, targetSymbol, position, parts);

        return parts.join('::');
    }

    private buildNameHierarchy(
        symbols: vscode.DocumentSymbol[],
        targetSymbol: vscode.DocumentSymbol,
        position: vscode.Position,
        parts: string[]
    ): boolean {
        for (const symbol of symbols) {
            if (symbol === targetSymbol) {
                parts.push(symbol.name);
                return true;
            }

            if (symbol.range.contains(position) && symbol.children && symbol.children.length > 0) {
                // This symbol might be a parent (namespace, class, etc.)
                if (symbol.kind === vscode.SymbolKind.Namespace ||
                    symbol.kind === vscode.SymbolKind.Class ||
                    symbol.kind === vscode.SymbolKind.Struct ||
                    symbol.kind === vscode.SymbolKind.Module) {
                    parts.push(symbol.name);
                }

                if (this.buildNameHierarchy(symbol.children, targetSymbol, position, parts)) {
                    return true;
                }

                // If we didn't find it in children, remove this symbol's name
                if (symbol.kind === vscode.SymbolKind.Namespace ||
                    symbol.kind === vscode.SymbolKind.Class ||
                    symbol.kind === vscode.SymbolKind.Struct ||
                    symbol.kind === vscode.SymbolKind.Module) {
                    parts.pop();
                }
            }
        }
        return false;
    }
}
