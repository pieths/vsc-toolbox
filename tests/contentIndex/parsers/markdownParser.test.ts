// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Tests for the Markdown parser ({@link markdownParser}).
 *
 * Exercises the full IFileParser contract:
 *   extractSymbols() — CST → raw symbol arrays
 *   hydrateSymbols() — raw symbol arrays → IndexSymbol[]
 *   computeChunks()  — source lines + symbols → Chunk[]
 *
 * This test can be run from the command line with:
 * npx tsc -p tests/tsconfig.json; node --test out-test/tests/common/index/parsers/markdownParser.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { markdownParser } from '../../../../src/common/index/parsers/markdown/markdownParser';
import {
    setUniformTokenizer,
    makeChunkingConfig,
} from './parserTestUtils';

/**
 * Default chunking config matching the production budgets passed to
 * the parser by {@link CacheManager}.
 */
const CHUNKING_CONFIG = makeChunkingConfig(2046, 3584);

// ── Static properties ───────────────────────────────────────────────────────

describe('static properties', () => {
    it('should support .md extension', () => {
        const exts = markdownParser.supportedExtensions;
        assert.ok(exts.includes('.md'), 'missing .md extension');
    });

    it('should reference markdown.wasm grammar only', () => {
        assert.deepStrictEqual(markdownParser.wasmGrammars, ['markdown.wasm']);
    });

    it('formatVersion should be a positive integer', () => {
        assert.ok(Number.isInteger(markdownParser.formatVersion));
        assert.ok(markdownParser.formatVersion >= 1);
    });
});

// ── Edge cases ──────────────────────────────────────────────────────────────

describe('edge cases', () => {
    it('extractSymbols with null rootNode should return empty array', () => {
        const result = markdownParser.extractSymbols(null, 'test.md');
        assert.deepStrictEqual(result, []);
    });

    it('hydrateSymbols with empty array should return empty array', () => {
        const result = markdownParser.hydrateSymbols([]);
        assert.deepStrictEqual(result, []);
    });

    it('computeChunks with empty source should return empty array', async () => {
        setUniformTokenizer(0.3);
        const chunks = await markdownParser.computeChunks([], [], 'empty.md', CHUNKING_CONFIG);
        assert.deepStrictEqual(chunks, []);
    });

    it('computeChunks with no symbols should still produce chunks if file has content', async () => {
        setUniformTokenizer(0.3);
        const lines = [
            'This is a plain text file without any headings at all.',
            'It has multiple lines of content that should still be chunked.',
            'The chunking system needs enough text to meet the minimum threshold.',
            'So we add a few more lines here to make sure we exceed it safely.',
        ];
        const chunks = await markdownParser.computeChunks(lines, [], 'plain.md', CHUNKING_CONFIG);
        assert.ok(chunks.length == 1, 'expected one chunk from non-empty file');
    });
});
