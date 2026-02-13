// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Worker thread script for parallel content search and indexing.
 * This file runs in a separate worker thread and performs file operations.
 *
 * This module is bundled by esbuild into a standalone JS file, so imports
 * from other project files are resolved at build time.
 */

import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { IndexStatus } from './types';
import type {
    SearchInput,
    LineResult,
    SearchOutput,
    IndexInput,
    IndexOutput,
    ComputeChunksInput,
} from './types';
import { computeChunks } from './fileChunker';

const execFileAsync = promisify(execFile);

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
 * Search file content for matches using the provided regex pattern.
 * Uses progressive line counting - only computes line numbers for matches.
 *
 * @param content - Full file content to search
 * @param regexPattern - Regex pattern string to search for
 * @returns Array of results with line numbers and text
 */
function searchFileWithSingleRegex(content: string, regexPattern: string): LineResult[] {
    const regex = new RegExp(regexPattern, 'gim'); // g=global, i=case-insensitive, m=multiline

    const results: LineResult[] = [];
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

    return results;
}

/**
 * Search a file for matches using AND semantics across multiple regex patterns.
 * All patterns must match somewhere in the file for results to be returned.
 *
 * @param input - Search input containing file path and regex patterns array
 * @returns Search output with results or error
 */
async function searchFile(input: SearchInput): Promise<SearchOutput> {
    try {
        const content = await fs.promises.readFile(input.filePath, 'utf8');

        // If no patterns provided, return empty results
        if (!input.regexPatterns || input.regexPatterns.length === 0) {
            return { filePath: input.filePath, results: [] };
        }

        // Collect results for each pattern
        const allPatternResults: LineResult[][] = [];

        for (const pattern of input.regexPatterns) {
            const patternResults = searchFileWithSingleRegex(content, pattern);

            // If any pattern has no matches, the file doesn't match (AND semantics)
            if (patternResults.length === 0) {
                return { filePath: input.filePath, results: [] };
            }

            allPatternResults.push(patternResults);
        }

        // All patterns matched - merge results and deduplicate by line number
        const seenLines = new Set<number>();
        const mergedResults: LineResult[] = [];

        for (const patternResults of allPatternResults) {
            for (const result of patternResults) {
                if (!seenLines.has(result.line)) {
                    seenLines.add(result.line);
                    mergedResults.push(result);
                }
            }
        }

        // Sort by line number
        mergedResults.sort((a, b) => a.line - b.line);

        return { filePath: input.filePath, results: mergedResults };
    } catch (error) {
        return {
            filePath: input.filePath,
            results: [],
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Index a file using ctags.
 * Runs ctags to generate a JSON tags file for the input file.
 *
 * @param input - Index input containing file path, ctags path, and output tags path
 * @returns Index output with tags path or error
 */
async function indexFile(input: IndexInput): Promise<IndexOutput> {
    try {
        const sourceMtime = fs.statSync(input.filePath).mtimeMs;
        const tagsMtime = fs.statSync(input.tagsPath).mtimeMs;
        if (tagsMtime >= sourceMtime) {
            // The tags file is up-to-date, skip indexing
            return {
                type: 'index',
                status: IndexStatus.Skipped,
                filePath: input.filePath,
                tagsPath: input.tagsPath,
            };
        }
    } catch {
        // Tags file doesn't exist or other error - proceed with indexing
    }

    try {
        // Read source file and compute SHA256 hash
        const sourceContent = fs.readFileSync(input.filePath);
        const hash = crypto.createHash('sha256').update(sourceContent).digest('hex');

        if (fs.existsSync(input.tagsPath)) {
            // Check the SHA256 hash at the end of the tags file to see if
            // it matches the current source content. The last line is exactly:
            // {"_type": "sha256", "hash": "<64 hex chars>"}\n  (95 bytes)
            const HASH_LINE_LEN = 96;
            const HASH_OFFSET = 29; // offset to the start of the 64-char hex hash
            const fileSize = fs.statSync(input.tagsPath).size;
            if (fileSize >= HASH_LINE_LEN) {
                const fd = fs.openSync(input.tagsPath, 'r');
                const buf = Buffer.alloc(HASH_LINE_LEN);
                fs.readSync(fd, buf, 0, HASH_LINE_LEN, fileSize - HASH_LINE_LEN);
                fs.closeSync(fd);
                const storedHash = buf.toString('utf8').substring(HASH_OFFSET, HASH_OFFSET + 64);
                if (storedHash === hash) {
                    return {
                        type: 'index',
                        status: IndexStatus.Skipped,
                        filePath: input.filePath,
                        tagsPath: input.tagsPath,
                    };
                }
            }

            // Delete existing tags file - ctags refuses to overwrite it.
            // JSON-format tags files because they don't look like traditional tags
            // TODO: remove this when using ctags version that supports force overwrites.
            try {
                fs.unlinkSync(input.tagsPath);
            } catch (err) {
                console.error(`Failed to delete ${input.tagsPath}:`, err);
            }
        }

        // Run ctags with JSON output format
        // --fields=+neZKS: line number, end line, scope with kind, kind full name, signature
        // --kinds-all='*': include all symbol kinds
        // --output-format=json: structured JSON output
        await execFileAsync(input.ctagsPath, [
            '--output-format=json',
            '--fields=+cneNZKS',
            '--kinds-all=*',
            '-o', input.tagsPath,
            input.filePath
        ], { timeout: 3000 });

        // Append hash line at the end of the tags file
        if (fs.existsSync(input.tagsPath)) {
            // If modifying this line format, also update the
            // HASH_LINE_LEN and HASH_OFFSET constants above
            // and update the same values in FileIndex.isValid().
            fs.appendFileSync(input.tagsPath, `{"_type": "sha256", "hash": "${hash}"}\n`);
        } else {
            return {
                type: 'index',
                status: IndexStatus.Failed,
                filePath: input.filePath,
                tagsPath: null,
                error: 'ctags did not produce an output file in the allotted time'
            };
        }

        return {
            type: 'index',
            status: IndexStatus.Indexed,
            filePath: input.filePath,
            tagsPath: input.tagsPath,
        };
    } catch (error) {
        return {
            type: 'index',
            status: IndexStatus.Failed,
            filePath: input.filePath,
            tagsPath: null,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

// Listen for messages from the main thread
if (parentPort) {
    parentPort.on('message', async (input: SearchInput | IndexInput | ComputeChunksInput) => {
        if (input.type === 'index') {
            const output = await indexFile(input);
            parentPort!.postMessage(output);
        } else if (input.type === 'computeChunks') {
            const output = await computeChunks(input);
            parentPort!.postMessage(output);
        } else {
            const output = await searchFile(input);
            parentPort!.postMessage(output);
        }
    });
}
