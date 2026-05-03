// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Markdown file parser.
 *
 * Handles `.md` files using only the block-level tree-sitter grammar
 * (`markdown.wasm`). The inline grammar (`markdown_inline.wasm`) is
 * intentionally not loaded — heading text is kept as-is, including any
 * inline Markdown formatting (e.g. `**bold**`, `` `code` ``).
 *
 * Only ATX headings at levels 1 (`#`) and 2 (`##`) are extracted.
 * Each heading produces a symbol whose extent covers the entire
 * {@link https://spec.commonmark.org/0.31.2/#sections section} —
 * from the `#` marker through to the character before the next
 * same-or-higher-level heading (or EOF). Level-2 sections nest
 * inside level-1 sections, analogous to methods inside namespaces
 * in C++.
 *
 * - {@link markdownParser.extractSymbols extractSymbols} uses a
 *   tree-sitter query to extract heading symbols as compact arrays
 *   for `*.idx` files.
 * - {@link markdownParser.readIndex readIndex} hydrates those arrays
 *   into typed {@link IndexSymbol} objects.
 * - {@link markdownParser.computeChunks computeChunks} produces
 *   heading-aware embedding chunks aligned to section boundaries.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Chunk, ChunkingConfig } from '../types';
import type { IndexSymbol, IFileParser } from '../types';
import { computeChunks } from './chunker';
import { extractSymbolsFromSyntaxTree } from './symbolExtractor';
import { hydrateSymbols } from './symbolHydrator';

/**
 * Markdown parser singleton implementing {@link IFileParser}.
 */
export const markdownParser: IFileParser = {
    supportedExtensions: ['.md'],
    wasmGrammars: ['markdown.wasm'],
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
