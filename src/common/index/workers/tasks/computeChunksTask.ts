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
import * as path from 'path';
import * as crypto from 'crypto';
import { ComputeChunksStatus } from '../../types';
import type { ComputeChunksInput, ComputeChunksOutput } from '../../types';
import type { IndexFile } from '../../parsers/types';
import { getParserForFile } from '../../parsers/registry';

/**
 * Compute a SHA-256 hex digest of the given text.
 *
 * @param text - The raw chunk text
 * @returns 64-character lowercase hex digest
 */
function getChunkHash(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Compute text chunks for a file.
 *
 * 1. Read the source file and split into lines.
 * 2. Look up the parser via the registry.
 * 3. Read and parse the `*.idx` file → hydrate symbols.
 * 4. Compute display path (workspace-relative or filename-only).
 * 5. Delegate to `parser.computeChunks()` with the display path.
 *
 * @param input - Input containing file path and idx path
 * @returns Output with extracted chunks
 */
export async function computeChunks(input: ComputeChunksInput): Promise<ComputeChunksOutput> {
    try {
        const contentBuffer = await fs.promises.readFile(input.filePath);
        const sha256 = crypto.createHash('sha256').update(contentBuffer).digest('hex');

        // Read and parse the *.idx file to get symbols
        const idxContent = await fs.promises.readFile(input.idxPath, 'utf8');
        const [
            idxSha256,
            scrubbedSha256,
            _version,
            _filePath,
            rawSymbols
        ] = JSON.parse(idxContent) as IndexFile;

        // If the source file has changed since the index
        // was built, skip chunking and report error.
        if (sha256 !== idxSha256) {
            return {
                type: 'computeChunks',
                status: ComputeChunksStatus.Error,
                filePath: input.filePath,
                chunks: [],
                error: `Source file changed since index was built (expected ${idxSha256}, got ${sha256})`,
            };
        }

        // Fast-path: skip if the scrubbed source hasn't changed since the
        // last successful embedding pass. Using scrubbedSha256 (from the
        // idx file) instead of the raw sha256 ensures that scrub-pattern
        // changes trigger re-chunking even when the source file is unchanged.
        if (input.storedSha256 && scrubbedSha256 === input.storedSha256) {
            return {
                type: 'computeChunks',
                status: ComputeChunksStatus.Skipped,
                filePath: input.filePath,
                chunks: [],
                sha256: scrubbedSha256,
            };
        }

        const fileParser = getParserForFile(input.filePath);
        const symbols = fileParser.readIndex(rawSymbols);

        // Delegate chunking to the parser
        const content = contentBuffer.toString('utf8');
        const sourceLines = content.split('\n');

        // Use workspace-relative path for chunk prefixes when available,
        // otherwise fall back to just the filename.
        const displayPath = input.workspacePath || path.basename(input.filePath);
        const chunks = fileParser.computeChunks(sourceLines, symbols, displayPath);

        // Compute sha256 over the final chunk text (including context prefix)
        // so that the hash accurately reflects what gets embedded.
        for (const chunk of chunks) {
            chunk.sha256 = getChunkHash(chunk.text);
        }

        return {
            type: 'computeChunks',
            status: ComputeChunksStatus.Computed,
            filePath: input.filePath,
            chunks,
            sha256: scrubbedSha256,
        };
    } catch (error) {
        return {
            type: 'computeChunks',
            status: ComputeChunksStatus.Error,
            filePath: input.filePath,
            chunks: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
