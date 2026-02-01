// Copyright (c) 2025 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';

/**
 * Map of file extensions to markdown language identifiers
 */
const languageMap: { [key: string]: string } = {
    'cpp': 'cpp',
    'cc': 'cpp',
    'h': 'cpp',
    'hpp': 'cpp',
    'c': 'c',
    'ts': 'typescript',
    'js': 'javascript',
    'py': 'python',
    'java': 'java',
    'cs': 'csharp',
    'go': 'go',
    'rs': 'rust',
};

/**
 * Creates a markdown code block with appropriate syntax highlighting
 * @param document The text document to read lines from
 * @param range The range of lines to include in the code block
 * @returns Array of markdown lines representing the code block
 */
export function createMarkdownCodeBlock(document: vscode.TextDocument, range: vscode.Range): string[];

/**
 * Creates a markdown code block with appropriate syntax highlighting
 * @param lines The lines of the file
 * @param range The range of lines to include in the code block
 * @param fileExtension The file extension (without dot) for language detection
 * @returns Array of markdown lines representing the code block
 */
export function createMarkdownCodeBlock(lines: string[], range: vscode.Range, fileExtension: string): string[];

export function createMarkdownCodeBlock(
    documentOrLines: vscode.TextDocument | string[],
    range: vscode.Range,
    fileExtension?: string
): string[] {
    const result: string[] = [];

    // Determine language from file extension
    let extension: string;
    if (Array.isArray(documentOrLines)) {
        extension = fileExtension || '';
    } else {
        const uri = documentOrLines.uri.toString();
        extension = uri.substring(uri.lastIndexOf('.') + 1).toLowerCase();
    }
    const language = languageMap[extension] || '';

    result.push('```' + language);
    for (let i = range.start.line; i <= range.end.line; i++) {
        if (Array.isArray(documentOrLines)) {
            result.push(documentOrLines[i]);
        } else {
            result.push(documentOrLines.lineAt(i).text);
        }
    }
    result.push('```');

    return result;
}
