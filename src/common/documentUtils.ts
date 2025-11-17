// Copyright (c) 2025 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';

export function buildQualifiedName(
    symbols: vscode.DocumentSymbol[],
    targetSymbol: vscode.DocumentSymbol,
    position: vscode.Position
): string {
    const parts: string[] = [];

    // Build the hierarchy by finding parent symbols
    buildNameHierarchy(symbols, targetSymbol, position, parts);

    return parts.join('::');
}

function buildNameHierarchy(
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

            if (buildNameHierarchy(symbol.children, targetSymbol, position, parts)) {
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
