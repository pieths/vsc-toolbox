// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * C / C++ / header file parser.
 *
 * Handles `.c`, `.cc`, `.cpp`, `.cxx`, `.h`, `.hh`, `.hpp`, `.hxx`.
 *
 * - {@link cppParser.extractSymbols extractSymbols} uses tree-sitter
 *   queries to extract symbols from the CST as compact arrays for
 *   `*.idx` files.
 * - {@link cppParser.readIndex readIndex} hydrates those arrays into
 *   typed {@link IndexSymbol} objects.
 * - {@link cppParser.computeChunks computeChunks} produces
 *   structure-aware embedding chunks aligned to function / class
 *   boundaries.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Chunk, ChunkingConfig } from '../types';
import type { IndexSymbol, IFileParser } from '../types';
import { computeChunks } from './chunker';
import { extractSymbolsFromSyntaxTree } from './symbolExtractor';
import { hydrateSymbols } from './symbolHydrator';

// ── Parser singleton ────────────────────────────────────────────────────────

/**
 * C / C++ parser singleton implementing {@link IFileParser}.
 */
export const cppParser: IFileParser = {
    supportedExtensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'],
    wasmGrammars: ['cpp.wasm'],
    formatVersion: 1,

    extractSymbols(
        rootNode: SyntaxNode | null,
        _filePath: string
    ): unknown[][] {
        if (!rootNode) {
            return [];
        }
        return extractSymbolsFromSyntaxTree(rootNode);
    },

    readIndex(symbols: unknown[][]): IndexSymbol[] {
        return hydrateSymbols(symbols);
    },

    async computeChunks(
        sourceLines: readonly string[],
        symbols: readonly IndexSymbol[],
        filePath: string,
        config: ChunkingConfig,
    ): Promise<Chunk[]> {
        return computeChunks(sourceLines, symbols, filePath, config);
    },
};
