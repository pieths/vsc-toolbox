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
 * Get the range for a function signature.
 * Currently only implemented for C++.
 * @param document The text document
 * @param functionNameRange The range of the function name
 * @returns Range covering the complete function signature
 */
export function getFunctionSignatureRange(
    document: vscode.TextDocument,
    functionNameRange: vscode.Range
): vscode.Range;

/**
 * Get the range for a function signature.
 * Currently only implemented for C++.
 * @param lines The lines of the file
 * @param startLine The 0-based line number where the function starts
 * @returns Range covering the complete function signature
 */
export function getFunctionSignatureRange(
    lines: string[],
    startLine: number
): vscode.Range;

export function getFunctionSignatureRange(
    documentOrLines: vscode.TextDocument | string[],
    functionNameRangeOrStartLine: vscode.Range | number
): vscode.Range {
    let startLine: number;
    let startChar: number;
    let isCpp: boolean;
    let getLineText: (lineNum: number) => string;
    let lineCount: number;

    if (Array.isArray(documentOrLines)) {
        // Lines-based version
        const lines = documentOrLines;
        startLine = functionNameRangeOrStartLine as number;
        startChar = 0;
        lineCount = lines.length;
        getLineText = (lineNum: number) => lines[lineNum];
        // For lines-based version, assume C++ (caller is responsible for context)
        isCpp = true;
    } else {
        // Document-based version
        const document = documentOrLines;
        const functionNameRange = functionNameRangeOrStartLine as vscode.Range;
        startLine = functionNameRange.start.line;
        startChar = functionNameRange.start.character;
        lineCount = document.lineCount;
        getLineText = (lineNum: number) => document.lineAt(lineNum).text;
        const languageId = document.languageId;
        isCpp = languageId === 'cpp' || languageId === 'c';
    }

    // TODO: check to see if using document symbols would work better for
    // handling more complex signatures (i.e. return type on line above).
    // For C++, search forward until we find ';' or '{'
    if (isCpp) {
        for (let lineNum = startLine; lineNum < lineCount; lineNum++) {
            const lineText = getLineText(lineNum);
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

    // For non-C++ languages or if we didn't find ';' or '{', return a single-line range
    if (Array.isArray(documentOrLines)) {
        return new vscode.Range(startLine, 0, startLine, documentOrLines[startLine].length);
    } else {
        return functionNameRangeOrStartLine as vscode.Range;
    }
}
