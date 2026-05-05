// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Tests for the C/C++ parser ({@link cppParser}).
 *
 * This test can be run from the command line with:
 * npx tsc -p tests/tsconfig.json; node --test out-test/tests/contentIndex/parsers/cppParser.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { cppParser } from '../../../src/contentIndex/parsers/cpp/cppParser';
import {
    makeChunkingConfig,
    setUniformTokenizer,
} from './parserTestUtils';

// ── Static properties ───────────────────────────────────────────────────────

describe('static properties', () => {
    it('should list all C/C++ extensions', () => {
        const exts = cppParser.supportedExtensions;
        for (const ext of ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx']) {
            assert.ok(exts.includes(ext), `missing extension ${ext}`);
        }
    });

    it('should reference cpp.wasm grammar', () => {
        assert.deepStrictEqual(cppParser.wasmGrammars, ['cpp.wasm']);
    });

    it('formatVersion should be a positive integer', () => {
        assert.ok(Number.isInteger(cppParser.formatVersion));
        assert.ok(cppParser.formatVersion >= 1);
    });
});

// ── Edge cases ──────────────────────────────────────────────────────────────

describe('edge cases', () => {

    /**
     * Default chunking config matching the production budgets passed to
     * the parser by {@link CacheManager}.
     */
    const CHUNKING_CONFIG = makeChunkingConfig(2046, 3584);

    it('extractSymbols with null rootNode should return empty array', () => {
        const result = cppParser.extractSymbols(null, 'test.cpp');
        assert.deepStrictEqual(result, []);
    });

    it('hydrateSymbols with empty array should return empty array', () => {
        const result = cppParser.hydrateSymbols([]);
        assert.deepStrictEqual(result, []);
    });

    it('computeChunks with empty source should return empty array', async () => {
        setUniformTokenizer(0.3);
        const chunks = await cppParser.computeChunks([], [], 'empty.cpp', CHUNKING_CONFIG);
        assert.deepStrictEqual(chunks, []);
    });

    it('computeChunks with no symbols should still produce chunks if file has content', async () => {
        setUniformTokenizer(0.3);
        const lines = [
            '#include <stdio.h>',
            '',
            'int main() {',
            '    printf("Hello, world!\\n");',
            '    printf("This is a test.\\n");',
            '    printf("Adding more lines for minimum chunk size.\\n");',
            '    printf("And even more content here.\\n");',
            '    return 0;',
            '}',
        ];
        const chunks = await cppParser.computeChunks(lines, [], 'main.cpp', CHUNKING_CONFIG);
        // With no symbols, the entire file is treated as trailing content
        assert.ok(chunks.length >= 1, 'expected at least one chunk from non-empty file');
    });
});
