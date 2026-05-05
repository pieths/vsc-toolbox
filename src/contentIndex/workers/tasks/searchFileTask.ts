// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Worker task: search files for matches using OR semantics
 * across multiple glob/regex patterns. Returns per-pattern
 * frequency and line number data.
 */

import * as path from 'path';
import type {
    SearchOutput,
} from '../../types';
import { parseQueryAsAndOr } from '../../../queryParser';

// Load the native addon using an absolute path to the .node file.
// The require() call loads the generated index.js which handles
// platform detection and loads the correct .node binary.
const runoSearchPath = path.join(__dirname, '..', 'bin', 'win_x64', 'runo-search', 'index.js');

let nativeSearchFilesOr: (
    filePaths: string[],
    patterns: string[],
    unicode: boolean,
    caseInsensitive: boolean,
) => Array<{
    filePath: string;
    totalLines: number;
    patterns: Array<{ patternIndex: number; frequency: number; lineNumbers: number[] }>;
}>;

try {
    const runoSearch = require(runoSearchPath);
    nativeSearchFilesOr = runoSearch.searchFilesOr;
} catch (e) {
    // If loading fails, log the error and provide a fallback that always returns empty
    console.log(`[runo-search] Failed to load native addon from ${runoSearchPath}: ${e}`);
    nativeSearchFilesOr = () => [];
}

/**
 * Search a batch of files in one native call using OR semantics.
 * Returns per-pattern frequency and line number data.
 * Only files with at least one pattern match are included.
 *
 * @param query - Search query string
 * @param filePaths - Absolute file paths to search
 * @param isRegexp - When true, treat query as a single regex pattern
 */
export function searchFiles(query: string, filePaths: string[], isRegexp: boolean): SearchOutput[] {
    if (filePaths.length === 0 || !query || !query.trim()) {
        return [];
    }

    const regexPatterns = isRegexp ? [query.trim()] : parseQueryAsAndOr(query);
    if (regexPatterns.length === 0) {
        return [];
    }

    try {
        // Call native addon with OR semantics
        // unicode=false for performance (source code is predominantly ASCII)
        const nativeResults = nativeSearchFilesOr(
            filePaths,
            regexPatterns,
            /*unicode=*/ false,
            /*caseInsensitive=*/ !isRegexp,
        );

        // Convert native results to SearchOutput.
        // Line numbers from native are 1-based; convert to 0-based.
        return nativeResults.map(fileResult => ({
            type: 'search' as const,
            filePath: fileResult.filePath,
            totalLines: fileResult.totalLines,
            patternMatches: fileResult.patterns.map(p => ({
                patternIndex: p.patternIndex,
                frequency: p.frequency,
                lineNumbers: p.lineNumbers.map(ln => ln - 1),
            })),
        }));
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return filePaths.map(filePath => ({
            type: 'search' as const,
            filePath,
            totalLines: 0,
            patternMatches: [],
            error: errorMsg,
        }));
    }
}
