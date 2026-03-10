// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface PathMatch {
    path: string;
    type: 'file' | 'url';
    lineNumber?: number;
    column?: number;
}

/**
 * Patterns for matching file paths and URLs in text, ordered by priority.
 * Higher priority patterns are tried first.
 */
const PATH_PATTERNS: Array<{ regex: RegExp; type: 'file' | 'url' }> = [
    // HTTP/HTTPS URLs
    { regex: /https?:\/\/[^\s"'<>,;\x60)]+/g, type: 'url' },
    // File URIs
    { regex: /file:\/\/\/[^\s"'<>,;\x60)]+/g, type: 'file' },
    // Windows absolute paths (drive letter + colon + separator)
    { regex: /[A-Za-z]:[\\\/][^\s"'<>|,;\x60()]+/g, type: 'file' },
    // UNC paths (\\server\share)
    { regex: /\\\\[^\s"'<>|,;\x60()]+/g, type: 'file' },
    // Unix absolute paths (must not be preceded by word char, colon, or slash)
    { regex: /(?<![:\w\/])\/[^\s"'<>|,;\x60()]+/g, type: 'file' },
    // Explicit relative paths (./... or ../...)
    { regex: /\.\.?[\\\/][^\s"'<>|,;\x60()]+/g, type: 'file' },
    // Bare relative paths containing directory separator
    { regex: /[\w\-.][\w.\-]*[\\\/][\w.\-\\\/]+/g, type: 'file' },
    // Bare filename with extension
    { regex: /[\w\-][\w.\-]*\.\w{1,10}/g, type: 'file' },
];

/**
 * Delimiter pairs for extracting content enclosed in common delimiters.
 */
const DELIMITERS: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
    ['(', ')'],
    ['[', ']'],
];

/**
 * Open File Under Cursor Command - Opens a file path or URL found at the cursor position.
 *
 * Supports:
 * - Windows absolute paths (C:\foo\bar.txt)
 * - UNC paths (\\server\share\file.txt)
 * - Unix absolute paths (/usr/local/bin/foo)
 * - HTTP/HTTPS URLs
 * - file:/// URIs
 * - Relative paths (./foo, ../bar, src/foo.ts)
 * - Bare filenames (foo.txt) via workspace search
 * - Line/column suffixes: path:42, path:42:10, path(42), path(42,10), path#L42
 * - Paths enclosed in quotes, backticks, parentheses, or brackets
 */
export class OpenFileUnderCursorCommand {
    public readonly id = 'vscToolbox.openFileUnderCursor';
    public readonly title = 'VSC Toolbox: Open File Under Cursor';

    constructor(private context: vscode.ExtensionContext) { }

    async execute(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor');
            return;
        }

        const position = editor.selection.active;
        const lineText = editor.document.lineAt(position.line).text;
        const cursorCol = position.character;

        const match = await this.findPathAtCursor(lineText, cursorCol);

        if (!match) {
            vscode.window.showInformationMessage('No file path or URL found under cursor');
            return;
        }

        if (match.type === 'url') {
            await vscode.env.openExternal(vscode.Uri.parse(match.path));
        } else {
            await this.openFile(match.path, match.lineNumber, match.column);
        }
    }

    /**
     * Find a file path or URL at the given cursor position in the line text.
     */
    private async findPathAtCursor(lineText: string, cursorCol: number): Promise<PathMatch | undefined> {
        // Step 1: Try delimited content as a whole path.
        // This handles paths with spaces (e.g. "C:\Program Files\app\file.txt").
        const delimited = this.extractDelimitedContent(lineText, cursorCol);
        if (delimited) {
            const result = await this.tryAsPath(delimited.text);
            if (result) {
                return result;
            }
        }

        // Step 2: Try regex patterns on the full line
        for (const pattern of PATH_PATTERNS) {
            const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
            let match;
            while ((match = regex.exec(lineText)) !== null) {
                const matchStart = match.index;
                const matchEnd = match.index + match[0].length;

                if (cursorCol >= matchStart && cursorCol <= matchEnd) {
                    // Peek past the match for a line/column suffix that
                    // the path regex itself didn't capture (e.g. :42, :42:10,
                    // (42), (42,10), #L42, #L42-L50).
                    const suffix = this.peekLineColumnSuffix(lineText, matchEnd);
                    if (suffix) {
                        const extended = match[0] + suffix;
                        const result = await this.tryAsPath(extended, pattern.type);
                        if (result) {
                            return result;
                        }
                    }

                    const result = await this.tryAsPath(match[0], pattern.type);
                    if (result) {
                        return result;
                    }
                }
            }
        }

        return undefined;
    }

    /**
     * Try to interpret a string as a file path or URL.
     * Returns a PathMatch if successful, undefined otherwise.
     */
    private async tryAsPath(rawText: string, typeHint?: 'file' | 'url'): Promise<PathMatch | undefined> {
        const trimmed = rawText.trim();
        if (!trimmed) {
            return undefined;
        }

        // Detect type
        const type = typeHint ?? this.detectType(trimmed);

        if (type === 'url') {
            const cleaned = this.stripTrailingPunctuation(trimmed);
            return { path: cleaned, type: 'url' };
        }

        // Handle file:/// URIs
        let filePath = trimmed;
        if (filePath.startsWith('file:///')) {
            try {
                filePath = vscode.Uri.parse(filePath).fsPath;
            } catch {
                // Invalid URI, use as-is
            }
        }

        // Try extracting line/column from the raw path first, before
        // stripping punctuation (which would remove trailing ')' needed
        // for the path(42) format).
        const lineColRaw = this.extractLineColumn(filePath);
        if (lineColRaw) {
            const resolvedRaw = await this.resolveFilePath(lineColRaw.path);
            if (resolvedRaw) {
                return {
                    path: resolvedRaw,
                    type: 'file',
                    lineNumber: lineColRaw.lineNumber,
                    column: lineColRaw.column,
                };
            }
        }

        // Strip trailing punctuation
        filePath = this.stripTrailingPunctuation(filePath);

        // Try without line/column extraction
        let resolved = await this.resolveFilePath(filePath);
        if (resolved) {
            return { path: resolved, type: 'file' };
        }

        // Try extracting line/column from the stripped path
        const lineCol = this.extractLineColumn(filePath);
        if (lineCol) {
            resolved = await this.resolveFilePath(lineCol.path);
            if (resolved) {
                return {
                    path: resolved,
                    type: 'file',
                    lineNumber: lineCol.lineNumber,
                    column: lineCol.column,
                };
            }
        }

        return undefined;
    }

    /**
     * Detect whether a string is a URL or file path.
     */
    private detectType(text: string): 'file' | 'url' {
        if (/^https?:\/\//i.test(text)) {
            return 'url';
        }
        return 'file';
    }

    /**
     * Extract content enclosed in delimiters around the cursor position.
     * Returns the narrowest delimited region containing the cursor.
     */
    private extractDelimitedContent(lineText: string, cursorCol: number): { text: string; start: number } | undefined {
        let best: { text: string; start: number; length: number } | undefined;

        for (const [open, close] of DELIMITERS) {
            let start = -1;

            if (open === close) {
                // Symmetric delimiter: find nearest occurrence to the left
                for (let i = cursorCol - 1; i >= 0; i--) {
                    if (lineText[i] === open) {
                        start = i + 1;
                        break;
                    }
                }
            } else {
                // Asymmetric delimiter: find nearest open char to the left
                for (let i = cursorCol - 1; i >= 0; i--) {
                    if (lineText[i] === open) {
                        start = i + 1;
                        break;
                    }
                    if (lineText[i] === close) {
                        break; // Found close before open - not inside this pair
                    }
                }
            }

            if (start === -1) {
                continue;
            }

            // Find nearest close char to the right of cursor
            let end = -1;
            for (let i = cursorCol; i < lineText.length; i++) {
                if (lineText[i] === close) {
                    end = i;
                    break;
                }
                if (open !== close && lineText[i] === open) {
                    break; // Found another open before close - nested, skip
                }
            }

            if (end === -1) {
                continue;
            }

            const length = end - start;
            if (!best || length < best.length) {
                best = {
                    text: lineText.substring(start, end),
                    start,
                    length,
                };
            }
        }

        return best ? { text: best.text, start: best.start } : undefined;
    }

    /**
     * Strip trailing punctuation characters that are likely not part of the path.
     */
    private stripTrailingPunctuation(text: string): string {
        return text.replace(/[.,;:!?\)\]\}]+$/, '');
    }

    /**
     * Try to extract line and column numbers from the end of a path string.
     *
     * Supported formats:
     *   path:42:10   (line and column)
     *   path:42      (line only)
     *   path(42,10)  (line and column)
     *   path(42)     (line only)
     *   path#L42     (GitHub-style line)
     *   path#L42-L50 (GitHub-style line range)
     */
    private extractLineColumn(filePath: string): { path: string; lineNumber: number; column?: number } | undefined {
        // Try :line:column first (greedy .+ to match the rightmost colon pair)
        const lineColMatch = filePath.match(/^(.+):(\d+):(\d+)$/);
        if (lineColMatch) {
            return {
                path: lineColMatch[1],
                lineNumber: parseInt(lineColMatch[2], 10),
                column: parseInt(lineColMatch[3], 10),
            };
        }

        // Try :line only (greedy .+ to match the rightmost colon)
        const lineMatch = filePath.match(/^(.+):(\d+)$/);
        if (lineMatch && lineMatch[1].length > 1) {
            return {
                path: lineMatch[1],
                lineNumber: parseInt(lineMatch[2], 10),
            };
        }

        // Try (line,column) or (line)
        const parenMatch = filePath.match(/^(.+)\((\d+)(?:,\s*(\d+))?\)$/);
        if (parenMatch) {
            return {
                path: parenMatch[1],
                lineNumber: parseInt(parenMatch[2], 10),
                column: parenMatch[3] ? parseInt(parenMatch[3], 10) : undefined,
            };
        }

        // Try #L42 or #L42-L50 (GitHub-style)
        const hashMatch = filePath.match(/^(.+)#L(\d+)(?:-L(\d+))?$/);
        if (hashMatch) {
            return {
                path: hashMatch[1],
                lineNumber: parseInt(hashMatch[2], 10),
            };
        }

        return undefined;
    }

    /**
     * Peek at the text immediately after a regex match to see if there's a
     * line/column suffix that wasn't captured by the path regex.
     *
     * Supported suffix formats:
     *   :42          (line only)
     *   :42:10       (line and column)
     *   (42)         (line only)
     *   (42,10)      (line and column)
     *   #L42         (GitHub-style line)
     *   #L42-L50     (GitHub-style line range)
     *
     * Returns the suffix string if found, or undefined.
     */
    private peekLineColumnSuffix(lineText: string, matchEnd: number): string | undefined {
        const rest = lineText.substring(matchEnd);
        const suffixMatch = rest.match(/^(?::\d+(?::\d+)?|\(\d+(?:,\s*\d+)?\)|#L\d+(?:-L\d+)?)/);
        return suffixMatch?.[0];
    }

    /**
     * Resolve a file path to an absolute path, checking existence.
     * Tries: absolute path, relative to current file directory, relative to
     * workspace folders, workspace search for bare filenames.
     */
    private async resolveFilePath(filePath: string): Promise<string | undefined> {
        const normalizedPath = path.normalize(filePath);

        // 1. Try as absolute path
        if (path.isAbsolute(normalizedPath)) {
            if (fs.existsSync(normalizedPath)) {
                return normalizedPath;
            }
            return this.tryStrippingTrailingChars(normalizedPath);
        }

        // 2. Try relative to the current file's directory
        const editor = vscode.window.activeTextEditor;
        if (editor && !editor.document.isUntitled) {
            const currentDir = path.dirname(editor.document.uri.fsPath);
            const fullPath = path.resolve(currentDir, normalizedPath);
            if (fs.existsSync(fullPath)) {
                return fullPath;
            }
            const stripped = this.tryStrippingTrailingChars(fullPath);
            if (stripped) {
                return stripped;
            }
        }

        // 3. Try relative to workspace folders
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            for (const folder of workspaceFolders) {
                const wsFullPath = path.join(folder.uri.fsPath, normalizedPath);
                if (fs.existsSync(wsFullPath)) {
                    return wsFullPath;
                }
                const stripped = this.tryStrippingTrailingChars(wsFullPath);
                if (stripped) {
                    return stripped;
                }
            }
        }

        // 4. Try as bare filename - search workspace
        if (!filePath.includes('/') && !filePath.includes('\\')) {
            const files = await vscode.workspace.findFiles(`**/${filePath}`, undefined, 5);
            if (files.length === 1) {
                return files[0].fsPath;
            }
            if (files.length > 1) {
                const items = files.map(f => ({
                    label: vscode.workspace.asRelativePath(f),
                    description: f.fsPath,
                    uri: f,
                }));
                const picked = await vscode.window.showQuickPick(items, {
                    placeHolder: `Multiple files found for "${filePath}". Select one:`,
                });
                return picked?.uri.fsPath;
            }
        }

        return undefined;
    }

    /**
     * Try stripping trailing characters one at a time to find an existing path.
     */
    private tryStrippingTrailingChars(filePath: string): string | undefined {
        let p = filePath;
        while (p.length > 0) {
            const lastChar = p[p.length - 1];
            if (/[.,;:!?\)\]\}]/.test(lastChar)) {
                p = p.slice(0, -1);
                if (fs.existsSync(p)) {
                    return p;
                }
            } else {
                break;
            }
        }
        return undefined;
    }

    /**
     * Open a file in the editor, optionally at a specific line and column.
     * If the path is a directory, reveal it in the OS file explorer.
     */
    private async openFile(filePath: string, lineNumber?: number, column?: number): Promise<void> {
        try {
            const uri = vscode.Uri.file(filePath);

            // If it's a directory, open it directly in the OS file explorer
            if (fs.statSync(filePath).isDirectory()) {
                await vscode.env.openExternal(uri);
                return;
            }

            const document = await vscode.workspace.openTextDocument(uri);

            const options: vscode.TextDocumentShowOptions = {};
            if (lineNumber !== undefined) {
                const line = Math.max(0, lineNumber - 1); // Convert to 0-based
                const col = column !== undefined ? Math.max(0, column - 1) : 0;
                const position = new vscode.Position(line, col);
                options.selection = new vscode.Range(position, position);
            }

            await vscode.window.showTextDocument(document, options);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open file: ${filePath}. ${error}`);
        }
    }
}
