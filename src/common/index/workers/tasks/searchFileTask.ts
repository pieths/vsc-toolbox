// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Worker task: search a file for matches using AND semantics
 * across multiple glob/regex patterns.
 */

import * as fs from 'fs';
import type {
    SearchInput,
    LineResult,
    SearchOutput,
} from '../../types';
import { parseQueryAsAnd } from '../../../queryParser';

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
 * Extract literal substrings from a glob term by splitting on wildcards.
 * Returns an array of non-empty literal fragments that can be used for
 * a fast Buffer.indexOf pre-check before the more expensive regex search.
 *
 * @param term - A single glob term (e.g., "foo*bar", "get?Name")
 * @returns Array of literal fragments (e.g., ["foo", "bar"], ["get", "Name"])
 */
function extractLiterals(term: string): string[] {
    return term.split(/[*?]+/).filter(s => s.length > 0);
}

/**
 * Search a file for matches using AND semantics across multiple regex patterns.
 * All patterns must match somewhere in the file for results to be returned.
 *
 * @param input - Search input containing file path and regex patterns array
 * @returns Search output with results or error
 */
export async function searchFile(input: SearchInput): Promise<SearchOutput> {
    try {
        // Parse glob query to get individual terms and regex patterns
        const query = input.query;
        if (!query || !query.trim()) {
            return { type: 'search', filePath: input.filePath, results: [] };
        }

        const regexPatterns = parseQueryAsAnd(query);
        if (regexPatterns.length === 0) {
            return { type: 'search', filePath: input.filePath, results: [] };
        }

        // Extract literal fragments from the original glob terms for fast pre-check
        const globTerms = query.trim().split(/\s+/);
        const literalsByTerm = globTerms.map(extractLiterals);

        // Read file as Buffer first (no UTF-8 decode yet)
        const buffer = fs.readFileSync(input.filePath);

        // Fast pre-check: verify all AND terms have at least one literal present in the buffer.
        // If any term's literals are all missing, the file can't match — skip it entirely.
        for (const literals of literalsByTerm) {
            if (literals.length === 0) {
                // Term is purely wildcards (e.g., "*" or "???") — can't pre-filter, must search
                continue;
            }
            const found = literals.some(lit => buffer.indexOf(lit) !== -1);
            if (!found) {
                return { type: 'search', filePath: input.filePath, results: [] };
            }
        }

        // Pre-check passed — decode to string and run full regex search
        const content = buffer.toString('utf8');

        // Collect results for each pattern
        const allPatternResults: LineResult[][] = [];

        for (const pattern of regexPatterns) {
            const patternResults = searchFileWithSingleRegex(content, pattern);

            // If any pattern has no matches, the file doesn't match (AND semantics)
            if (patternResults.length === 0) {
                return { type: 'search', filePath: input.filePath, results: [] };
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

        return { type: 'search', filePath: input.filePath, results: mergedResults };
    } catch (error) {
        return {
            type: 'search',
            filePath: input.filePath,
            results: [],
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
