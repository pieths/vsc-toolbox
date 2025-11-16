// Copyright (c) 2025 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';

/**
 * Creates a markdown code block with appropriate syntax highlighting
 * @param document The text document to read lines from
 * @param range The range of lines to include in the code block
 * @returns Array of markdown lines representing the code block
 */
export function createMarkdownCodeBlock(document: vscode.TextDocument, range: vscode.Range): string[] {
    const lines: string[] = [];

    // Determine language from file extension
    const extension = document.uri.toString().substring(document.uri.toString().lastIndexOf('.') + 1).toLowerCase();
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
    const language = languageMap[extension] || '';

    lines.push('```' + language);
    for (let i = range.start.line; i <= range.end.line; i++) {
        lines.push(document.lineAt(i).text);
    }
    lines.push('```');

    return lines;
}
