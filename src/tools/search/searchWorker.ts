// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Worker thread script for parallel file search and indexing.
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
 * Get line number from byte position using binary search.
 *
 * @param lineStarts - Array of byte positions where each line starts
 * @param position - Byte position in file
 * @returns 1-based line number
 */
function getLineNumber(lineStarts: number[], position: number): number {
    let low = 0;
    let high = lineStarts.length - 1;

    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (lineStarts[mid] <= position) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }

    return low + 1; // Convert to 1-based
}

/**
 * Extract the full line text given a line number.
 *
 * @param content - Full file content
 * @param lineStarts - Array of byte positions where each line starts
 * @param lineNumber - 1-based line number
 * @returns Line text without trailing newline
 */
function getLineText(content: string, lineStarts: number[], lineNumber: number): string {
    const lineIndex = lineNumber - 1; // Convert to 0-based

    const startPos = lineStarts[lineIndex];
    let endPos: number;

    if (lineIndex + 1 < lineStarts.length) {
        // Next line exists, end before its start (excluding the newline)
        endPos = lineStarts[lineIndex + 1] - 1;
    } else {
        // Last line, go to end of content
        endPos = content.length;
    }

    // Handle Windows line endings (\r\n)
    let text = content.substring(startPos, endPos);
    if (text.endsWith('\r')) {
        text = text.slice(0, -1);
    }

    return text;
}

/**
 * Search a file for matches using the provided regex pattern.
 *
 * @param input - Search input containing file path, regex pattern, and line starts
 * @returns Search output with results or error
 */
async function searchFile(input: SearchInput): Promise<SearchOutput> {
    try {
        const content = await fs.promises.readFile(input.filePath, 'utf8');
        const regex = new RegExp(input.regexPattern, 'gim'); // g=global, i=case-insensitive, m=multiline

        const results: { line: number; text: string }[] = [];
        const seenLines = new Set<number>(); // Avoid duplicate lines

        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
            const lineNumber = getLineNumber(input.lineStarts, match.index);

            if (!seenLines.has(lineNumber)) {
                seenLines.add(lineNumber);
                const text = getLineText(content, input.lineStarts, lineNumber);
                results.push({ line: lineNumber, text });
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
