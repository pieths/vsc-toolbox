// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Default (fallback) parser for files without a language-specific grammar.
 *
 * Produces an empty symbol list — the file still gets an `*.idx` file
 * (containing an {@link IndexFile} tuple with an empty symbols array),
 * so staleness checks and caching work uniformly. Chunking falls back
 * to plain sliding-window splitting with a file-path-only context prefix.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { IndexSymbol, IFileParser } from './types';
import type { Chunk } from '../types';
import { splitIntoChunks, chunksToOneBased } from './chunkUtils';

/**
 * Fallback parser singleton.
 *
 * - `supportedExtensions` is empty — it matches nothing and is used
 *   only when the registry finds no language-specific parser.
 * - `wasmGrammars` is empty — no tree-sitter grammar is needed.
 * - `parseCst()` returns an empty array (no structured symbols).
 * - `readIndex()` returns an empty array.
 * - `computeChunks()` uses plain sliding-window chunking.
 */
export const defaultParser: IFileParser = {
    supportedExtensions: [],
    wasmGrammars: [],
    formatVersion: 1,

    parseCst(_rootNode: SyntaxNode | null, _filePath: string): unknown[][] {
        return [];  // no structured symbols to extract
    },

    readIndex(_symbols: unknown[][]): IndexSymbol[] {
        return [];  // empty index → no symbols
    },

    computeChunks(
        sourceLines: readonly string[],
        _symbols: readonly IndexSymbol[],
        _filePath: string,
    ): Chunk[] {
        // No structure — fall back to plain sliding-window chunking
        const chunks = splitIntoChunks(sourceLines, 0, sourceLines.length);
        chunksToOneBased(chunks);
        return chunks;
    },
};
