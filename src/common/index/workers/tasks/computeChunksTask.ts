// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Worker task: split a source file into text chunks for embedding.
 *
 * Reads the source file and its corresponding `*.idx` file, hydrates
 * symbols via the parser registry, and delegates to the parser's
 * `computeChunks()` for structure-aware (or fallback) chunking.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import type { ComputeChunksInput, ComputeChunksOutput } from '../../types';
import type { IndexFile } from '../../parsers/types';
import { getParserForFile } from '../../parsers/registry';

/**
 * Compute text chunks for a file.
 *
 * 1. Read the source file and split into lines.
 * 2. Look up the parser via the registry.
 * 3. Read and parse the `*.idx` file → hydrate symbols.
 * 4. Delegate to `parser.computeChunks()`.
 *
 * @param input - Input containing file path and idx path
 * @returns Output with extracted chunks
 */
export async function computeChunks(input: ComputeChunksInput): Promise<ComputeChunksOutput> {
    try {
        const contentBuffer = await fs.promises.readFile(input.filePath);
        const sha256 = crypto.createHash('sha256').update(contentBuffer).digest('hex');

        const fileParser = getParserForFile(input.filePath);

        // Read and parse the *.idx file to get symbols
        const idxContent = await fs.promises.readFile(input.idxPath, 'utf8');
        const [idxSha256, _version, _filePath, rawSymbols] = JSON.parse(idxContent) as IndexFile;

        // Verify the source file hasn't changed since the idx was built
        if (sha256 !== idxSha256) {
            return {
                type: 'computeChunks',
                filePath: input.filePath,
                chunks: [],
                error: `Source file changed since index was built (expected ${idxSha256}, got ${sha256})`,
            };
        }

        const symbols = fileParser.readIndex(rawSymbols);

        // Delegate chunking to the parser
        const content = contentBuffer.toString('utf8');
        const sourceLines = content.split('\n');
        const chunks = fileParser.computeChunks(sourceLines, symbols, input.filePath);

        return {
            type: 'computeChunks',
            filePath: input.filePath,
            chunks,
            sha256,
        };
    } catch (error) {
        return {
            type: 'computeChunks',
            filePath: input.filePath,
            chunks: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
