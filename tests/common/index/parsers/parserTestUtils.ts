// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Shared test utilities for parser unit tests.
 */

import * as path from 'node:path';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { SymbolType, AttrKey } from '../../../../src/common/index/parsers/types';
import type { IndexSymbol } from '../../../../src/common/index/parsers/types';
import type { ChunkingConfig } from '../../../../src/common/index/types';
import { _setGetTokenCountsMock } from '../../../../src/common/index/parsers/chunkUtils';

// Re-export for convenience so test files don't need a separate import.
export { SymbolType, AttrKey };
export type { IndexSymbol, ChunkingConfig };

/**
 * Resolve the absolute path to a tree-sitter WASM grammar file.
 *
 * Assumes tests are launched via `npm test` (or any equivalent that runs
 * from the project root), so that `process.cwd()` resolves to the
 * project root.
 *
 * @param grammar - The grammar filename (e.g. `'cpp.wasm'`, `'markdown.wasm'`).
 */
export function getWasmPath(grammar: string): string {
    return path.join(process.cwd(), 'bin', 'tree-sitter', 'languages', grammar);
}

/** Plain-object form of IndexSymbol for deep-equal comparison. */
export interface ComparableSymbol {
    type: SymbolType;
    name: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
    nameStartLine: number;
    nameStartColumn: number;
    nameEndLine: number;
    nameEndColumn: number;
    attrs: [AttrKey, string | number][];
}

/** Convert an IndexSymbol to a form suitable for deepStrictEqual. */
export function toComparable(sym: IndexSymbol): ComparableSymbol {
    return {
        type: sym.type,
        name: sym.name,
        startLine: sym.startLine,
        startColumn: sym.startColumn,
        endLine: sym.endLine,
        endColumn: sym.endColumn,
        nameStartLine: sym.nameStartLine,
        nameStartColumn: sym.nameStartColumn,
        nameEndLine: sym.nameEndLine,
        nameEndColumn: sym.nameEndColumn,
        attrs: [...sym.attrs.entries()].sort((a, b) => a[0] - b[0]),
    };
}

/** Build an expected symbol in comparable form. */
export function expectedSymbol(
    type: SymbolType,
    name: string,
    startLine: number, startColumn: number,
    endLine: number, endColumn: number,
    nameStartLine: number, nameStartColumn: number,
    nameEndLine: number, nameEndColumn: number,
    attrs: [AttrKey, string | number][] = [],
): ComparableSymbol {
    return {
        type, name, startLine, startColumn, endLine, endColumn,
        nameStartLine, nameStartColumn, nameEndLine, nameEndColumn,
        attrs: [...attrs].sort((a, b) => a[0] - b[0]),
    };
}

/** Filter symbols by optional name and/or type criteria. */
export function filterSymbols(
    symbols: readonly ComparableSymbol[],
    criteria: { name?: string; type?: SymbolType },
): ComparableSymbol[] {
    return symbols.filter(s =>
        (criteria.name === undefined || s.name === criteria.name) &&
        (criteria.type === undefined || s.type === criteria.type),
    );
}

/**
 * Pretty-print a tree-sitter syntax tree for debugging.
 *
 * Each named node is printed with its type, position range, and — for
 * leaf nodes — a truncated snippet of its text.  The field name linking
 * a child to its parent is shown as a prefix where available.
 *
 * @example Output:
 * ```
 * namespace_definition [0:0 - 3:1]
 *   name: identifier [0:10 - 0:13] "win"
 *   body: declaration_list [0:14 - 3:1]
 *     declaration [1:4 - 1:14]
 *       type: primitive_type [1:4 - 1:7] "int"
 *       ...
 * ```
 *
 * @param node  - The root node to print (typically `tree.rootNode`).
 * @param opts  - Optional settings.
 * @param opts.includeAnonymous - If `true`, also prints anonymous
 *   (unnamed) nodes such as punctuation and keywords. Defaults to `false`.
 * @param opts.maxLeafText - Maximum text length shown for leaf nodes.
 *   Defaults to `60`.
 * @returns The formatted tree string (no trailing newline).
 */
export function debugPrintSyntaxTree(
    node: SyntaxNode,
    opts: { includeAnonymous?: boolean; maxLeafText?: number } = {},
): string {
    const lines: string[] = [];
    const includeAnonymous = opts.includeAnonymous ?? false;
    const maxLeafText = opts.maxLeafText ?? 60;

    function walk(n: SyntaxNode, depth: number, fieldName?: string): void {
        if (!includeAnonymous && !n.isNamed) return;

        const indent = '  '.repeat(depth);
        const field = fieldName ? `${fieldName}: ` : '';
        const pos = `[${n.startPosition.row}:${n.startPosition.column} - ${n.endPosition.row}:${n.endPosition.column}]`;

        let line = `${indent}${field}${n.type} ${pos}`;

        // Show text for leaf nodes (no named children)
        if (n.namedChildCount === 0) {
            let text = n.text.replace(/\n/g, '\\n');
            if (text.length > maxLeafText) {
                text = text.substring(0, maxLeafText) + '…';
            }
            line += ` "${text}"`;
        }

        lines.push(line);

        for (let i = 0; i < n.childCount; i++) {
            const child = n.child(i)!;
            const childField = n.fieldNameForChild(i) ?? undefined;
            walk(child, depth + 1, childField);
        }
    }

    walk(node, 0);
    return lines.join('\n');
}

// ── Tokenizer mock utilities ────────────────────────────────────────────────

/**
 * Build a {@link ChunkingConfig} for tests. The hostname/port values are
 * irrelevant when using the mock tokenizer (set via {@link setUniformTokenizer}
 * or directly via `_setGetTokenCountsMock`).
 *
 * @param maxTokens - Token budget per chunk
 * @param maxCharacters - Character budget per chunk (default: 2000)
 */
export function makeChunkingConfig(
    maxTokens: number,
    maxCharacters: number = 2000,
): ChunkingConfig {
    return {
        maxTokens,
        maxCharacters,
        tokenizerHostName: 'localhost',
        tokenizerPort: 0,
    };
}

/**
 * Install a mock tokenizer that returns `tokensPerChar * text.length`
 * for each input string. This simulates a uniform chars/token ratio
 * and avoids hitting the real llama-server during tests.
 *
 * Call {@link clearTokenizerMock} in `afterEach` to restore the real
 * implementation.
 */
export function setUniformTokenizer(tokensPerChar: number): void {
    _setGetTokenCountsMock(async (contents: string[]) =>
        contents.map(c => Math.round(c.length * tokensPerChar)),
    );
}

/**
 * Remove the mock tokenizer, restoring the real `getTokenCounts`
 * implementation. Should be called in `afterEach`.
 */
export function clearTokenizerMock(): void {
    _setGetTokenCountsMock(null);
}
