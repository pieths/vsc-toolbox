// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Worker task: search a file for matches using AND
 * semantics across multiple glob/regex patterns.
 */

import * as path from 'path';
import type {
    SearchOutput,
} from '../../types';
import { parseQueryAsAnd } from '../../../queryParser';
import { workerLog } from '../workerLogger';

// Load the native addon using an absolute path to the .node file.
// The require() call loads the generated index.js which handles
// platform detection and loads the correct .node binary.
const runoSearchPath = path.join(__dirname, '..', 'bin', 'win_x64', 'runo-search', 'index.js');

let nativeSearchFiles: (
    filePaths: string[],
    patterns: string[],
    unicode: boolean,
    includeLines: boolean,
) => Array<{ filePath: string; lines: Array<{ line: number; text: string }> }>;

try {
    const runoSearch = require(runoSearchPath);
    nativeSearchFiles = runoSearch.searchFiles;
} catch (e) {
    // If loading fails, log the error and provide a fallback that always returns empty
    console.log(`[runo-search] Failed to load native addon from ${runoSearchPath}: ${e}`);
    nativeSearchFiles = () => [];
}

/**
 * Search a batch of files in one native call using AND semantics.
 * Only files with matches are included in the returned array.
 */
export function searchFiles(query: string, filePaths: string[]): SearchOutput[] {
    if (filePaths.length === 0 || !query || !query.trim()) {
        return [];
    }

    const regexPatterns = parseQueryAsAnd(query);
    if (regexPatterns.length === 0) {
        return [];
    }

    try {
        // Call native addon
        // unicode=false for performance (source code is predominantly ASCII)
        // includeLines=true to return full line text with results
        const nativeResults = nativeSearchFiles(filePaths, regexPatterns, false, true);

        // Only files with matches are returned by the native addon.
        // Convert from 1-based (native addon) to 0-based line numbers.
        return nativeResults.map(fileResult => ({
            type: 'search' as const,
            filePath: fileResult.filePath,
            results: fileResult.lines.map(r => ({ line: r.line - 1, text: r.text })),
        }));
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return filePaths.map(filePath => ({
            type: 'search' as const,
            filePath,
            results: [],
            error: errorMsg,
        }));
    }
}
