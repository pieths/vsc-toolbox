// Copyright (c) 2025 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';

export async function getQualifiedNameFromSymbolInfo(
    symbolInfo: vscode.SymbolInformation
): Promise<string> {
    // Get document symbols for the file
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        symbolInfo.location.uri
    );

    if (!symbols || symbols.length === 0) {
        return getFallbackQualifiedName(symbolInfo);
    }

    // Find the matching DocumentSymbol by comparing name and location
    const targetSymbol = findDocumentSymbol(symbols, symbolInfo);

    if (!targetSymbol) {
        return getFallbackQualifiedName(symbolInfo);
    }

    return getQualifiedNameFromDocumentSymbol(
        symbols,
        targetSymbol,
        symbolInfo.location.range.start);
}

export function getQualifiedNameFromDocumentSymbol(
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
            // This symbol might be a parent (namespace, class, enum, etc.)
            if (symbol.kind === vscode.SymbolKind.Namespace ||
                symbol.kind === vscode.SymbolKind.Class ||
                symbol.kind === vscode.SymbolKind.Struct ||
                symbol.kind === vscode.SymbolKind.Module ||
                symbol.kind === vscode.SymbolKind.Enum) {
                parts.push(symbol.name);
            }

            if (buildNameHierarchy(symbol.children, targetSymbol, position, parts)) {
                return true;
            }

            // If we didn't find it in children, remove this symbol's name
            if (symbol.kind === vscode.SymbolKind.Namespace ||
                symbol.kind === vscode.SymbolKind.Class ||
                symbol.kind === vscode.SymbolKind.Struct ||
                symbol.kind === vscode.SymbolKind.Module ||
                symbol.kind === vscode.SymbolKind.Enum) {
                parts.pop();
            }
        }
    }
    return false;
}

function getFallbackQualifiedName(symbolInfo: vscode.SymbolInformation): string {
    if (symbolInfo.containerName) {
        // Fallback to containerName if available. This won't be as complete
        // as using DocumentSymbols. For example, when getting symbols for
        // "kVP9" in the chromium code base using
        // vscode.executeWorkspaceSymbolProvider here are the differences:
        //
        // Symbol: kVP9Profile0
        // buildNameHierarchy name: cdm::VideoCodecProfile::kVP9Profile0
        // containerName: cdm
        //
        // Symbol: kVP9Profile0
        // buildNameHierarchy name: media::(anonymous namespace)::LimitedCodecProfile::kVP9Profile0
        // containerName: media::LimitedCodecProfile
        return `${symbolInfo.containerName}::${symbolInfo.name}`;
    }
    return symbolInfo.name;
}

/**
 * Find a DocumentSymbol that matches the given SymbolInformation by comparing
 * name, kind, and selectionRange (identifier location).
 * @param symbols Array of document symbols to search through
 * @param symbolInfo The symbol information to match
 * @returns The matching DocumentSymbol, or undefined if not found
 */
function findDocumentSymbol(
    symbols: vscode.DocumentSymbol[],
    symbolInfo: vscode.SymbolInformation
): vscode.DocumentSymbol | undefined {
    for (const symbol of symbols) {
        // Must match name and kind
        if (symbol.name === symbolInfo.name && symbol.kind === symbolInfo.kind) {
            // Check for exact selectionRange match (identifier to identifier)
            if (symbol.selectionRange.isEqual(symbolInfo.location.range)) {
                return symbol;
            }
        }

        // Recursively search children
        if (symbol.children && symbol.children.length > 0) {
            const found = findDocumentSymbol(symbol.children, symbolInfo);
            if (found) {
                return found;
            }
        }
    }

    return undefined;
}

/**
 * TODO: look into updating ctags to provide signature ranges directly.
 * Get the range for a function signature by searching forward until ';' or '{'.
 * Currently assumes C++ syntax. Tracks brace depth to handle brace-initialized
 * default parameters like `void foo(std::vector<int> v = {1, 2, 3});`
 * @param lines The lines of the file
 * @param startLine The 0-based line number where the function starts
 * @param startColumn The 0-based column number where the symbol name starts (optional, defaults to 0)
 * @returns Range covering the complete function signature
 */
export function getFunctionSignatureRange(
    lines: string[],
    startLine: number,
    startColumn: number = 0
): vscode.Range {
    // Search forward until we find ';' or '{' at brace depth 0
    let braceDepth = 0;

    for (let lineNum = startLine; lineNum < lines.length; lineNum++) {
        const lineText = lines[lineNum];
        // Start from startColumn on the first line, 0 on subsequent lines
        const startChar = lineNum === startLine ? startColumn : 0;

        for (let charIndex = startChar; charIndex < lineText.length; charIndex++) {
            const char = lineText[charIndex];

            if (char === '{') {
                if (braceDepth === 0) {
                    // Found the function body opening brace at depth 0
                    return new vscode.Range(
                        startLine,
                        0,
                        lineNum,
                        charIndex + 1
                    );
                }
                braceDepth++;
            } else if (char === '}') {
                braceDepth--;
            } else if (char === ';' && braceDepth === 0) {
                // Found the end of a declaration at depth 0
                return new vscode.Range(
                    startLine,
                    0,
                    lineNum,
                    charIndex + 1
                );
            }
        }
    }

    // If we didn't find ';' or '{', return a single-line range
    return new vscode.Range(startLine, 0, startLine, lines[startLine].length);
}
