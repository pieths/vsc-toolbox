// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Worker thread script for parallel content search and indexing.
 * This file runs in a separate worker thread and performs file operations.
 *
 * IMPORTANT: This module must be standalone with no runtime imports from other
 * project files. Type-only imports are safe as they are erased at compile time.
 */

import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import type { SearchInput, SearchOutput, IndexInput, IndexOutput } from './types';

// Global error handlers to prevent worker crashes
process.on('uncaughtException', (error) => {
    console.error('Worker uncaught exception:', error);
});
process.on('unhandledRejection', (reason) => {
    console.error('Worker unhandled rejection:', reason);
});

/**
 * Extract the full line text containing a match position.
 * Uses indexOf/lastIndexOf for efficiency.
 *
 * @param content - Full file content
 * @param matchIndex - Position of the match in the content
 * @returns Line text without trailing newline
 */
function getLineText(content: string, matchIndex: number): string {
    // Find line start (character after previous newline, or 0)
    const lineStart = content.lastIndexOf('\n', matchIndex - 1) + 1;

    // Find line end (next newline, or end of content)
    let lineEnd = content.indexOf('\n', matchIndex);
    if (lineEnd === -1) {
        lineEnd = content.length;
    }

    // Extract and handle Windows line endings (\r\n)
    let text = content.substring(lineStart, lineEnd);
    if (text.endsWith('\r')) {
        text = text.slice(0, -1);
    }

    return text;
}

/**
 * Search a file for matches using the provided regex pattern.
 * Uses progressive line counting - only computes line numbers for matches.
 *
 * @param input - Search input containing file path and regex pattern
 * @returns Search output with results or error
 */
async function searchFile(input: SearchInput): Promise<SearchOutput> {
    try {
        const content = await fs.promises.readFile(input.filePath, 'utf8');
        const regex = new RegExp(input.regexPattern, 'gim'); // g=global, i=case-insensitive, m=multiline

        const results: { line: number; text: string }[] = [];
        const seenLines = new Set<number>(); // Avoid duplicate lines

        // Progressive line counting - only computed when matches found
        let lastPos = 0;
        let currentLine = 1;

        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
            // Count newlines from lastPos to match position using indexOf
            let pos = lastPos;
            while (pos < match.index) {
                const nextNewline = content.indexOf('\n', pos);
                if (nextNewline === -1 || nextNewline >= match.index) {
                    break;
                }
                currentLine++;
                pos = nextNewline + 1;
            }
            lastPos = pos;

            if (!seenLines.has(currentLine)) {
                seenLines.add(currentLine);
                const text = getLineText(content, match.index);
                results.push({ line: currentLine, text });
            }
        }

        return { filePath: input.filePath, results };
    } catch (error) {
        return {
            filePath: input.filePath,
            results: [],
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Build line index for a file.
 *
 * @param input - Index input containing file path
 * @returns Index output with lineStarts array or error
 */
async function indexFile(input: IndexInput): Promise<IndexOutput> {
    try {
        const content = await fs.promises.readFile(input.filePath, 'utf8');

        const lineStarts: number[] = [0]; // Line 1 starts at position 0

        let pos = 0;
        while ((pos = content.indexOf('\n', pos)) !== -1) {
            lineStarts.push(pos + 1);
            pos++;
        }

        return { type: 'index', filePath: input.filePath, lineStarts };
    } catch (error) {
        return {
            type: 'index',
            filePath: input.filePath,
            lineStarts: null,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

// Listen for messages from the main thread
if (parentPort) {
    parentPort.on('message', async (input: SearchInput | IndexInput) => {
        if (input.type === 'index') {
            const output = await indexFile(input);
            parentPort!.postMessage(output);
        } else {
            const output = await searchFile(input);
            parentPort!.postMessage(output);
        }
    });
}
