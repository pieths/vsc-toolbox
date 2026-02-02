// Copyright (c) 2025 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import * as path from 'path';

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
 * @param lines The lines of the file
 * @param range The range of lines to include in the code block
 * @param filePath The full file path for language detection
 * @returns Array of markdown lines representing the code block
 */
export function createMarkdownCodeBlock(
    lines: string[],
    range: vscode.Range,
    filePath: string
): string[] {
    const result: string[] = [];
    const fileExtension = path.extname(filePath).slice(1).toLowerCase();
    const language = languageMap[fileExtension] || '';

    result.push('```' + language);
    for (let i = range.start.line; i <= range.end.line; i++) {
        result.push(lines[i]);
    }
    result.push('```');

    return result;
}
