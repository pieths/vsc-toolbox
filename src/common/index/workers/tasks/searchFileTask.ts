// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Worker task: search a file for matches using AND
 * semantics across multiple glob/regex patterns.
 */

import * as path from 'path';
import type {
    SearchInput,
    SearchOutput,
} from '../../types';
import { parseQueryAsAnd } from '../../../queryParser';
import { workerLog } from '../workerLogger';

// Load the native addon using an absolute path to the .node file.
// The require() call loads the generated index.js which handles
// platform detection and loads the correct .node binary.
const runoSearchPath = path.join(__dirname, '..', 'bin', 'win_x64', 'runo-search', 'index.js');

let nativeSearchFile: (
    filePath: string,
    patterns: string[],
    unicode: boolean,
    includeLines: boolean,
) => Array<{ line: number; text: string }>;

try {
    const runoSearch = require(runoSearchPath);
    nativeSearchFile = runoSearch.searchFile;
} catch (e) {
    // If loading fails, log the error and provide a fallback that always returns empty
    console.log(`[runo-search] Failed to load native addon from ${runoSearchPath}: ${e}`);
    nativeSearchFile = () => [];
}

/**
 * Search a file for matches using AND semantics across multiple regex patterns.
 */
export async function searchFile(input: SearchInput): Promise<SearchOutput> {
    try {
        const query = input.query;
        if (!query || !query.trim()) {
            return { type: 'search', filePath: input.filePath, results: [] };
        }

        // Convert glob query to regex patterns (done in TypeScript)
        const regexPatterns = parseQueryAsAnd(query);
        if (regexPatterns.length === 0) {
            return { type: 'search', filePath: input.filePath, results: [] };
        }

        // Call native addon
        // unicode=false for performance (source code is predominantly ASCII)
        // includeLines=true to return full line text with results
        const results = nativeSearchFile(input.filePath, regexPatterns, false, true);

        return { type: 'search', filePath: input.filePath, results };
    } catch (error) {
        return {
            type: 'search',
            filePath: input.filePath,
            results: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
