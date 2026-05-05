// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Tests for internal helpers in {@link chunkUtils}.
 *
 * This test can be run from the command line with:
 * npx tsc -p tests/tsconfig.json; node --test out-test/tests/common/index/parsers/chunkUtils.test.js
 */

import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { SplitLineView } from '../../../../src/common/index/parsers/splitLineView';
import {
    _findChunkEndByTokenEstimate as findChunkEndByTokenEstimate,
    _findChunkStartByTokenEstimate as findChunkStartByTokenEstimate,
    _splitChunkRange as splitChunkRange,
    _setGetTokenCountsMock as setGetTokenCountsMock,
    splitIntoChunks,
    OVERLAP_LINES,
    MIN_CHUNK_CHARS,
    MAX_LINE_LENGTH,
} from '../../../../src/common/index/parsers/chunkUtils';
import type { ChunkRange } from '../../../../src/common/index/parsers/chunkUtils';
import type { ChunkingConfig } from '../../../../src/common/index/types';
import { setUniformTokenizer, clearTokenizerMock } from './parserTestUtils';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Create a SplitLineView from raw strings (no splitting, identity mode). */
function makeView(lines: string[]): SplitLineView {
    return new SplitLineView(lines, 10_000);
}

/** Create a uniform Float32Array filled with a single ratio value. */
function createUniformRatioArray(length: number, ratio: number): Float32Array {
    const arr = new Float32Array(length);
    arr.fill(ratio);
    return arr;
}

/** Create a ChunkRange with the given bounds and optional prefixes. */
function chunkRange(
    startLine: number,
    endLine: number,
    primaryPrefix = '',
    secondaryPrefix = '',
): ChunkRange {
    return { startLine, endLine, primaryPrefix, secondaryPrefix };
}

/**
 * Generate N lines of content, each `charsPerLine` characters long.
 * Each line is 'line_NN_' + padding to reach the target length.
 */
function createContentLines(numLines: number, charsPerLine: number): string[] {
    const lines: string[] = [];
    for (let i = 0; i < numLines; i++) {
        const label = `line_${String(i).padStart(2, '0')}_`;
        lines.push(label + 'x'.repeat(Math.max(0, charsPerLine - label.length)));
    }
    return lines;
}

// ── findChunkEndByTokenEstimate ─────────────────────────────────────────────

describe('findChunkEndByTokenEstimate', () => {

    it('returns end when all lines fit within budget', () => {
        const lines = ['short', 'also', 'fine'];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(3, 0.3);
        // Total estimated: sum of (len+1)*0.3 for each line
        // = (6)*0.3 + (5)*0.3 + (5)*0.3 = 1.8 + 1.5 + 1.5 = 4.8
        const result = findChunkEndByTokenEstimate(view, 0, 3, 100, 0, ratio);
        assert.equal(result, 3);
    });

    it('returns end when all lines exactly equal budget', () => {
        const line = 'abcd'; // length 4, +1 = 5
        const view = makeView([line]);
        const ratio = createUniformRatioArray(1, 1.0);
        // Estimated: 5 * 1.0 = 5.0, budget = 5 → not > 5, so returns end
        const result = findChunkEndByTokenEstimate(view, 0, 1, 5, 0, ratio);
        assert.equal(result, 1);
    });

    it('stops at the line that exceeds budget', () => {
        // 5 lines of 9 chars each → (9+1)*0.5 = 5.0 tokens per line
        const lines = Array(5).fill('123456789');
        const view = makeView(lines);
        const ratio = createUniformRatioArray(5, 0.5);
        // Budget = 12: line 0 → 5.0, line 1 → 10.0, line 2 → 15.0 (exceeds 12)
        // Returns max(2, 0+1) = 2
        const result = findChunkEndByTokenEstimate(view, 0, 5, 12, 0, ratio);
        assert.equal(result, 2);
    });

    it('always includes at least one line even if it exceeds budget', () => {
        const lines = ['a very long line that will exceed the budget on its own'];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(1, 1.0);
        // (55+1)*1.0 = 56 tokens, budget = 5
        // i=0 exceeds, returns max(0, 0+1) = 1
        const result = findChunkEndByTokenEstimate(view, 0, 1, 5, 0, ratio);
        assert.equal(result, 1);
    });

    it('always includes at least one line when starting mid-range', () => {
        const lines = ['short', 'a very long line that exceeds budget', 'short2'];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(3, 1.0);
        // Starting at index 1, budget = 5
        // Line 1: (37+1)*1.0 = 38, exceeds 5
        // Returns max(1, 1+1) = 2
        const result = findChunkEndByTokenEstimate(view, 1, 3, 5, 0, ratio);
        assert.equal(result, 2);
    });

    it('accounts for prefix token estimate', () => {
        // Each line: (9+1)*0.5 = 5.0 tokens
        const lines = Array(5).fill('123456789');
        const view = makeView(lines);
        const ratio = createUniformRatioArray(5, 0.5);
        // Prefix = 8, budget = 12
        // After prefix: 8, line 0 → 13 (exceeds 12)
        // Returns max(0, 0+1) = 1
        const result = findChunkEndByTokenEstimate(view, 0, 5, 12, 8, ratio);
        assert.equal(result, 1);
    });

    it('handles prefix that alone exceeds budget (still includes one line)', () => {
        const lines = ['hello'];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(1, 0.5);
        // Prefix = 100, budget = 10
        // estimatedTokens starts at 100, already > 10 after line 0
        // Returns max(0, 0+1) = 1
        const result = findChunkEndByTokenEstimate(view, 0, 1, 10, 100, ratio);
        assert.equal(result, 1);
    });

    it('respects per-line ratio differences', () => {
        const lines = ['aaaa', 'bbbb', 'cccc']; // all length 4, +1 = 5
        const view = makeView(lines);
        const ratio = new Float32Array([0.5, 2.0, 0.5]);
        // Line 0: 5*0.5 = 2.5
        // Line 1: 5*2.0 = 10.0, total = 12.5
        // Budget = 10 → line 1 exceeds, return max(1, 0+1) = 1
        const result = findChunkEndByTokenEstimate(view, 0, 3, 10, 0, ratio);
        assert.equal(result, 1);
    });

    it('handles sub-range (start > 0)', () => {
        const lines = ['a', 'bb', 'ccc', 'dddd', 'eeeee'];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(5, 1.0);
        // Starting at index 2, end at 5, budget = 10
        // Line 2: (3+1)*1 = 4, line 3: (4+1)*1 = 5, total = 9
        // Line 4: (5+1)*1 = 6, total = 15 → exceeds
        // Returns max(4, 2+1) = 4
        const result = findChunkEndByTokenEstimate(view, 2, 5, 10, 0, ratio);
        assert.equal(result, 4);
    });

    it('handles single line range', () => {
        const lines = ['hello world'];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(1, 0.3);
        // (11+1)*0.3 = 3.6, budget = 100
        const result = findChunkEndByTokenEstimate(view, 0, 1, 100, 0, ratio);
        assert.equal(result, 1);
    });

    it('handles empty line (length 0)', () => {
        const lines = ['', 'content', ''];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(3, 1.0);
        // Line 0: (0+1)*1 = 1, line 1: (7+1)*1 = 8, total = 9
        // Line 2: (0+1)*1 = 1, total = 10, budget = 100
        const result = findChunkEndByTokenEstimate(view, 0, 3, 9, 0, ratio);
        assert.equal(result, 2);
    });

    it('first line exceeds budget returns start + 1', () => {
        const lines = ['tiny', 'big-line-that-exceeds'];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(2, 1.0);
        // Start at 0, budget = 3
        // Line 0: (4+1)*1 = 5, exceeds 3
        // Returns max(0, 0+1) = 1
        const result = findChunkEndByTokenEstimate(view, 0, 2, 3, 0, ratio);
        assert.equal(result, 1);
    });

    it('accumulates correctly across many lines', () => {
        // 10 lines, each 'aa' (length 2), ratio 1.0
        // Each line: (2+1)*1 = 3 tokens
        const lines = Array(10).fill('aa');
        const view = makeView(lines);
        const ratio = createUniformRatioArray(10, 1.0);
        // Budget = 9: lines 0,1,2 → 3+3+3 = 9, not exceeded
        // Line 3 → 12, exceeds 9. Returns max(3, 0+1) = 3
        const result = findChunkEndByTokenEstimate(view, 0, 10, 9, 0, ratio);
        assert.equal(result, 3);
    });

    it('budget exactly reached does not trigger early stop', () => {
        // Two lines: each (3+1)*1 = 4, total = 8
        const view = makeView(['abc', 'def']);
        const ratio = createUniformRatioArray(2, 1.0);
        // Budget = 8: both lines fit exactly (8 not > 8), returns end
        // If >= were used instead of >, it would stop after line 0
        const result = findChunkEndByTokenEstimate(view, 0, 2, 8, 0, ratio);
        assert.equal(result, 2);
    });

    it('budget exceeded by fraction triggers early stop', () => {
        // Two lines: each (3+1)*1 = 4.0
        const view = makeView(['abc', 'def']);
        const ratio = createUniformRatioArray(2, 1.0);
        // Budget = 7.9: line 0 → 4.0, line 1 → 8.0 (exceeds 7.9)
        // Returns max(1, 0+1) = 1 — second line excluded
        const result = findChunkEndByTokenEstimate(view, 0, 2, 7.9, 0, ratio);
        assert.equal(result, 1);
    });

    it('zero ratio means lines consume no budget', () => {
        const lines = Array(100).fill('anything');
        const view = makeView(lines);
        const ratio = createUniformRatioArray(100, 0);
        // Every line contributes 0 tokens, never exceeds budget
        const result = findChunkEndByTokenEstimate(view, 0, 100, 1, 0, ratio);
        assert.equal(result, 100);
    });

    it('very high ratio makes single line exceed budget', () => {
        const lines = ['a', 'b', 'c'];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(3, 1000);
        // Line 0: (1+1)*1000 = 2000, budget = 10
        // Returns max(0, 0+1) = 1
        const result = findChunkEndByTokenEstimate(view, 0, 3, 10, 0, ratio);
        assert.equal(result, 1);
    });

    it('works with the end parameter limiting the scan range', () => {
        const lines = ['a', 'b', 'c', 'd', 'e'];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(5, 0.1);
        // All lines fit easily, but end = 3 limits scan
        const result = findChunkEndByTokenEstimate(view, 0, 3, 1000, 0, ratio);
        assert.equal(result, 3);
    });
});

// ── findChunkStartByTokenEstimate ───────────────────────────────────────────

describe('findChunkStartByTokenEstimate', () => {

    it('returns start when all lines fit within budget', () => {
        const lines = ['short', 'also', 'fine'];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(3, 0.3);
        const result = findChunkStartByTokenEstimate(view, 0, 3, 100, 0, ratio);
        assert.equal(result, 0);
    });

    it('returns start when all lines exactly equal budget', () => {
        // 3 lines: each (4+1)*1 = 5, total = 15
        const lines = ['abcd', 'efgh', 'ijkl'];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(3, 1.0);
        // Budget = 10: scanning backward, lines 2+1 = 10 (exact, not > 10)
        // Line 0 would make 15 → exceeds. Returns min(0+1, 3-1) = 1
        // But budget = 15: all 3 lines fit exactly → returns start = 0
        const result = findChunkStartByTokenEstimate(view, 1, 3, 15, 0, ratio);
        assert.equal(result, 1);
    });

    it('finds the start line when scanning backward exceeds budget', () => {
        // 5 lines, each (9+1)*0.5 = 5.0 tokens
        const lines = Array(5).fill('123456789');
        const view = makeView(lines);
        const ratio = createUniformRatioArray(5, 0.5);
        // Budget = 12, scanning backward from end=5:
        // Line 4: 5.0, line 3: 10.0, line 2: 15.0 (exceeds 12)
        // Returns min(2+1, 5-1) = 3
        const result = findChunkStartByTokenEstimate(view, 0, 5, 12, 0, ratio);
        assert.equal(result, 3);
    });

    it('always includes at least one line (returns end - 1)', () => {
        const lines = ['x', 'y', 'a very long line that exceeds budget'];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(3, 1.0);
        // Budget = 5, scanning backward from end=3:
        // Line 2: (37+1)*1 = 38, exceeds 5
        // Returns min(2+1, 3-1) = min(3, 2) = 2
        const result = findChunkStartByTokenEstimate(view, 0, 3, 5, 0, ratio);
        assert.equal(result, 2);
    });

    it('accounts for prefix token estimate', () => {
        // Each line: (9+1)*0.5 = 5.0 tokens
        const lines = Array(5).fill('123456789');
        const view = makeView(lines);
        const ratio = createUniformRatioArray(5, 1);
        // Prefix = 8, budget = 16
        // Scanning backward: line 4: 10+8 = 13, exceeds 16
        // Returns min(4+1, 5-1) = min(5, 4) = 4
        const result = findChunkStartByTokenEstimate(view, 0, 5, 16, 8, ratio);
        assert.equal(result, 4);
    });

    it('handles prefix that alone exceeds budget (still includes one line)', () => {
        const lines = ['hello', 'world'];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(2, 0.5);
        // Prefix = 100, budget = 10
        // Line 1: (5+1)*0.5 + 100 = 103, exceeds 10
        // Returns min(1+1, 2-1) = min(2, 1) = 1
        const result = findChunkStartByTokenEstimate(view, 0, 2, 10, 100, ratio);
        assert.equal(result, 1);
    });

    it('respects per-line ratio differences', () => {
        const lines = ['aaaa', 'bbbb', 'cccc']; // all length 4, +1 = 5
        const view = makeView(lines);
        const ratio = new Float32Array([0.5, 2.0, 0.5]);
        // Budget = 10, scanning backward:
        // Line 2: 5*0.5 = 2.5
        // Line 1: 5*2.0 = 10.0, total = 12.5, exceeds 10
        // Returns min(1+1, 3-1) = 2
        const result = findChunkStartByTokenEstimate(view, 0, 3, 10, 0, ratio);
        assert.equal(result, 2);
    });

    it('handles sub-range (start > 0)', () => {
        const lines = ['a', 'bb', 'ccc', 'dddd', 'eeeee'];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(5, 1.0);
        // start=2, end=5, budget=10
        // Scanning backward: line 4: 6, line 3: 5, total=11 → exceeds 10
        // Returns min(3+1, 5-1) = 4
        const result = findChunkStartByTokenEstimate(view, 2, 5, 11, 0, ratio);
        assert.equal(result, 3);
    });

    it('returns start when budget covers entire sub-range', () => {
        const lines = ['a', 'bb', 'ccc', 'dddd', 'eeeee'];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(5, 0.1);
        // start=2, end=5, budget=100 — all lines fit
        const result = findChunkStartByTokenEstimate(view, 2, 5, 100, 0, ratio);
        assert.equal(result, 2);
    });

    it('handles single line sub-range', () => {
        const view = makeView(['skip', 'hello world', 'skip']);
        const ratio = createUniformRatioArray(3, 0.3);
        // start=1, end=2 → scans only line 1, fits easily → returns start=1
        const result = findChunkStartByTokenEstimate(view, 1, 2, 100, 0, ratio);
        assert.equal(result, 1);
    });

    it('last line exceeds budget returns end - 1', () => {
        const view = makeView(['short', 'hello world that is very long']);
        const ratio = createUniformRatioArray(2, 10);
        // start=0, end=2, budget=5
        // Scanning backward: line 1: (30+1)*10 = 310, exceeds 5
        // Returns min(1+1, 2-1) = 1 — only the last line
        const result = findChunkStartByTokenEstimate(view, 0, 2, 5, 0, ratio);
        assert.equal(result, 1);
    });

    it('zero ratio means all lines fit', () => {
        const lines = Array(100).fill('anything');
        const view = makeView(lines);
        const ratio = createUniformRatioArray(100, 0);
        const result = findChunkStartByTokenEstimate(view, 0, 100, 1, 0, ratio);
        assert.equal(result, 0);
    });

    it('very high ratio makes only last line fit', () => {
        const lines = ['a', 'b', 'c'];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(3, 1000);
        // Budget = 10, scanning backward:
        // Line 2: (1+1)*1000 = 2000, exceeds 10
        // Returns min(2+1, 3-1) = 2
        const result = findChunkStartByTokenEstimate(view, 0, 3, 10, 0, ratio);
        assert.equal(result, 2);
    });

    it('mirrors findChunkEndByTokenEstimate for symmetric content', () => {
        // 6 lines of equal length, budget fits exactly 3 lines
        const lines = Array(6).fill('xxxx'); // each (4+1)*1 = 5
        const view = makeView(lines);
        const ratio = createUniformRatioArray(6, 1.0);
        // Budget = 15: fits 3 lines exactly (15 not > 15)
        const endResult = findChunkEndByTokenEstimate(view, 0, 6, 15, 0, ratio);
        const startResult = findChunkStartByTokenEstimate(view, 0, 6, 15, 0, ratio);
        // End scans forward: 3 lines fit, returns 3 (line 3 would make 20)
        assert.equal(endResult, 3);
        // Start scans backward: 3 lines fit from end, returns 3
        assert.equal(startResult, 3);
    });

    it('handles empty lines', () => {
        const lines = ['', '', 'content', '', ''];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(5, 1.0);
        const result = findChunkStartByTokenEstimate(view, 0, 5, 2, 0, ratio);
        assert.equal(result, 3);
    });

    it('budget exactly reached does not trigger early stop', () => {
        // 2 lines: each (3+1)*1 = 4, total = 8
        const view = makeView(['abc', 'def', 'ghi']);
        const ratio = createUniformRatioArray(3, 1.0);
        // Budget = 8, scanning backward: 4 + 4 = 8, not > 8
        const result = findChunkStartByTokenEstimate(view, 0, 2, 8, 0, ratio);
        assert.equal(result, 0);
    });
});

// ── splitChunkRange ─────────────────────────────────────────────────────

describe('splitChunkRange', () => {

    // ── Empty / degenerate inputs ───────────────────────────────────────

    it('returns empty array when startLine >= endLine', () => {
        const view = makeView(['code']);
        const ratio = createUniformRatioArray(1, 0.3);
        const result = splitChunkRange(chunkRange(0, 0), view, 100, ratio);
        assert.equal(result.length, 0);
    });

    it('returns empty array when startLine > endLine', () => {
        const view = makeView(['code', 'more']);
        const ratio = createUniformRatioArray(2, 0.3);
        const result = splitChunkRange(chunkRange(5, 3), view, 100, ratio);
        assert.equal(result.length, 0);
    });

    // ── Single chunk (range fits in budget) ─────────────────────────────

    it('produces a single chunk when entire range fits in budget', () => {
        const lines = createContentLines(5, 20);
        const view = makeView(lines);
        const ratio = createUniformRatioArray(5, 0.3);
        const result = splitChunkRange(chunkRange(0, 5), view, 1000, ratio);
        assert.equal(result.length, 1);
        assert.equal(result[0].startLine, 0);
        assert.equal(result[0].endLine, 5);
    });

    it('single chunk text contains all content lines', () => {
        const lines = createContentLines(3, 30);
        const view = makeView(lines);
        const ratio = createUniformRatioArray(3, 0.3);
        const result = splitChunkRange(chunkRange(0, 3), view, 1000, ratio);
        assert.equal(result.length, 1);
        assert.equal(result[0].text, lines.join('\n'));
    });

    it('single chunk uses primaryPrefix', () => {
        const lines = createContentLines(3, 30);
        const view = makeView(lines);
        const ratio = createUniformRatioArray(3, 0.3);
        const prefix = 'file: test.cpp\n';
        const result = splitChunkRange(chunkRange(0, 3, prefix, 'secondary\n'), view, 1000, ratio);
        assert.equal(result.length, 1);
        assert.ok(result[0].text.startsWith(prefix));
        assert.equal(result[0].text, prefix + lines.join('\n'));
    });

    it('single chunk sha256 is empty string', () => {
        const lines = createContentLines(3, 30);
        const view = makeView(lines);
        const ratio = createUniformRatioArray(3, 0.3);
        const result = splitChunkRange(chunkRange(0, 3), view, 1000, ratio);
        assert.equal(result[0].sha256, '');
    });

    // ── Multiple chunks (greedy fill + overlap) ─────────────────────────

    it('splits into multiple chunks when range exceeds budget', () => {
        // 30 lines of 99 chars each, ratio 1.0
        // Each line: (99+1)*1 = 100 tokens. Budget = 1500 → 15 lines per chunk.
        // With OVERLAP_LINES = 10, next chunk starts at chunkEnd - 10.
        const lines = createContentLines(30, 99);
        const view = makeView(lines);
        const ratio = createUniformRatioArray(30, 1.0);
        const result = splitChunkRange(chunkRange(0, 30), view, 1500, ratio);

        // Greedy fill trace:
        // Chunk 0: lines 0-14 (15 lines × 100 = 1500 ≤ 1500, line 15 → 1600 > 1500)
        //   → [0, 15). Next current = max(15-10, 0+1) = 5
        // Chunk 1: starts at 5, lines 5-19 (15 lines × 100 = 1500 ≤ 1500, line 20 → 1600)
        //   → [5, 20). Next current = max(20-10, 5+1) = 10
        // Chunk 2: starts at 10, [10, 25). Next current = max(25-10, 10+1) = 15
        // Chunk 3: starts at 15, [15, 30) → chunkEnd = 30 >= endLine, break

        // Reverse-fill: findChunkStartByTokenEstimate(0, 30, 1500)
        // Scans backward: 15 lines fit (1500), 16th → 1600 > 1500
        // lastChunkStart = 30 - 15 = 15. Last raw chunk already starts at 15 → no dedup needed.

        assert.equal(result.length, 4);

        // Verify exact chunk boundaries
        assert.equal(result[0].startLine, 0);
        assert.equal(result[0].endLine, 15);
        assert.equal(result[1].startLine, 5);
        assert.equal(result[1].endLine, 20);
        assert.equal(result[2].startLine, 10);
        assert.equal(result[2].endLine, 25);
        assert.equal(result[3].startLine, 15);
        assert.equal(result[3].endLine, 30);

        // Every chunk's text should be content from its line range
        for (const chunk of result) {
            const expectedContent = lines.slice(chunk.startLine, chunk.endLine).join('\n');
            assert.equal(chunk.text, expectedContent);
        }

        // Every chunk's text length should be >= MIN_CHUNK_CHARS
        for (const chunk of result) {
            assert.ok(chunk.text.length >= MIN_CHUNK_CHARS,
                `Chunk text length ${chunk.text.length} should be >= ${MIN_CHUNK_CHARS}`);
        }

        // Consecutive chunks should have startLine < previous endLine (overlap)
        for (let i = 1; i < result.length; i++) {
            assert.ok(result[i].startLine < result[i - 1].endLine,
                `Chunk ${i} start (${result[i].startLine}) should be < chunk ${i - 1} end (${result[i - 1].endLine})`);
        }

        // All chunks should have startLine < endLine
        for (const chunk of result) {
            assert.ok(chunk.startLine < chunk.endLine,
                `Chunk startLine (${chunk.startLine}) should be < endLine (${chunk.endLine})`);
        }
    });

    it('first chunk uses primaryPrefix, subsequent use secondaryPrefix', () => {
        const lines = createContentLines(20, 20);
        const view = makeView(lines);
        const ratio = createUniformRatioArray(20, 1.0);
        const primary = 'PRIMARY\n';
        const secondary = 'SECONDARY\n';
        const result = splitChunkRange(chunkRange(0, 20, primary, secondary), view, 100, ratio);
        assert.ok(result.length >= 2);
        assert.ok(result[0].text.startsWith(primary));
        for (let i = 1; i < result.length; i++) {
            assert.ok(result[i].text.startsWith(secondary),
                `Chunk ${i} should start with secondary prefix`);
        }
    });

    it('chunks have correct overlap (OVERLAP_LINES)', () => {
        // 50 lines of 99 chars each, ratio 1.0
        // Each line: (99+1)*1 = 100 tokens. Budget = 2000 → 20 lines per chunk.
        // With OVERLAP_LINES = 10, next chunk starts at chunkEnd - 10, progress = 10.
        const lines = createContentLines(50, 99);
        const view = makeView(lines);
        const ratio = createUniformRatioArray(50, 1.0);
        const result = splitChunkRange(chunkRange(0, 50), view, 2000, ratio);

        // Greedy fill trace:
        // Chunk 0: [0, 20). Next current = max(20-10, 0+1) = 10
        // Chunk 1: [10, 30). Next current = max(30-10, 10+1) = 20
        // Chunk 2: [20, 40). Next current = max(40-10, 20+1) = 30
        // Chunk 3: [30, 50) → chunkEnd = 50 >= endLine, break
        // Reverse-fill: 20 lines from end = [30, 50). Same as last chunk → no dedup.

        assert.equal(result.length, 4);

        // Verify exact chunk boundaries
        assert.equal(result[0].startLine, 0);
        assert.equal(result[0].endLine, 20);
        assert.equal(result[1].startLine, 10);
        assert.equal(result[1].endLine, 30);
        assert.equal(result[2].startLine, 20);
        assert.equal(result[2].endLine, 40);
        assert.equal(result[3].startLine, 30);
        assert.equal(result[3].endLine, 50);

        // Every consecutive pair overlaps by exactly OVERLAP_LINES
        for (let i = 1; i < result.length; i++) {
            const overlap = result[i - 1].endLine - result[i].startLine;
            assert.equal(overlap, OVERLAP_LINES,
                `Overlap between chunk ${i - 1} and ${i} should be ${OVERLAP_LINES}, got ${overlap}`);
        }
    });

    // ── Reverse-fill last chunk ─────────────────────────────────────────

    it('last chunk is reverse-filled from end of range', () => {
        // Force 2+ chunks. Last chunk should end at endLine.
        const lines = createContentLines(20, 20);
        const view = makeView(lines);
        const ratio = createUniformRatioArray(20, 1.0);
        const result = splitChunkRange(chunkRange(0, 20), view, 100, ratio);
        assert.ok(result.length >= 2);
        const lastChunk = result[result.length - 1];
        assert.equal(lastChunk.endLine, 20);
    });

    it('reverse-fill last chunk has adaptive overlap', () => {
        // The last chunk should start earlier than a simple greedy would
        // because it fills backward from the end, maximizing content.
        const lines = createContentLines(15, 20);
        const view = makeView(lines);
        const ratio = createUniformRatioArray(15, 1.0);
        const result = splitChunkRange(chunkRange(0, 15), view, 100, ratio);
        if (result.length >= 2) {
            const lastChunk = result[result.length - 1];
            const prevChunk = result[result.length - 2];
            // Last chunk should overlap with previous
            assert.ok(lastChunk.startLine < prevChunk.endLine,
                'Last chunk should overlap with previous chunk');
        }
    });

    // ── Dedup: reverse-fill contains previous chunk ─────────────────────

    it('dedup drops previous chunk when reverse-fill fully contains it', () => {
        // 12 lines of 99 chars each, ratio 1.0 → each (99+1)*1 = 100 tokens.
        // primaryPrefix = 200 chars → 200 tokens. secondaryPrefix = '' → 0 tokens.
        // Budget = 1200.
        //
        // Forward greedy (chunk 0, primary prefix uses 200 tokens):
        //   Available for content: 1200 - 200 = 1000 → 10 lines fit (1000 ≤ 1200).
        //   → [0, 10). Next current = max(10-10, 0+1) = 1
        // Forward greedy (chunk 1, starts at 1, no secondary prefix):
        //   Lines 1-11 = 11 lines = 1100 ≤ 1200. → [1, 12). chunkEnd >= endLine, break.
        //
        // Reverse-fill: findChunkStartByTokenEstimate(0, 12, 1200, prefix=0):
        //   All 12 lines = 1200 ≤ 1200. lastChunkStart = 0.
        //   0 ≤ prevChunk.startLine(0) → dedup triggers, drop chunk 0.
        //
        // Result: 1 chunk [0, 12) with primaryPrefix (since it's at index 0).
        const lines = createContentLines(12, 99);
        const view = makeView(lines);
        const ratio = createUniformRatioArray(12, 1.0);
        const primary = 'x'.repeat(200);
        const result = splitChunkRange(chunkRange(0, 12, primary, ''), view, 1200, ratio);
        assert.equal(result.length, 1);
        assert.equal(result[0].startLine, 0);
        assert.equal(result[0].endLine, 12);
        assert.ok(result[0].text.startsWith(primary),
            'Surviving chunk should use primaryPrefix');
    });

    // ── Trimming ────────────────────────────────────────────────────────

    it('trims leading blank lines from chunks', () => {
        const lines = ['', '', ...createContentLines(3, 30)];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(5, 0.3);
        const result = splitChunkRange(chunkRange(0, 5), view, 1000, ratio);
        assert.equal(result.length, 1);
        assert.equal(result[0].startLine, 2); // skipped 2 blank lines
    });

    it('trims trailing blank lines from chunks', () => {
        const lines = [...createContentLines(3, 30), '', ''];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(5, 0.3);
        const result = splitChunkRange(chunkRange(0, 5), view, 1000, ratio);
        assert.equal(result.length, 1);
        assert.equal(result[0].endLine, 3); // stopped before blank lines
    });

    it('trims both leading and trailing blank lines', () => {
        const lines = ['', ...createContentLines(3, 30), ''];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(5, 0.3);
        const result = splitChunkRange(chunkRange(0, 5), view, 1000, ratio);
        assert.equal(result.length, 1);
        assert.equal(result[0].startLine, 1);
        assert.equal(result[0].endLine, 4);
    });

    // ── Filtering ───────────────────────────────────────────────────────

    it('filters out chunks shorter than MIN_CHUNK_CHARS', () => {
        // Lines that are very short — after trimming, total content < MIN_CHUNK_CHARS
        const lines = ['ab', 'cd', 'ef'];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(3, 0.3);
        const result = splitChunkRange(chunkRange(0, 3), view, 1000, ratio);
        // 'ab\ncd\nef' = 8 chars < MIN_CHUNK_CHARS (75)
        assert.equal(result.length, 0);
    });

    it('keeps chunks that meet MIN_CHUNK_CHARS', () => {
        const longLine = 'x'.repeat(MIN_CHUNK_CHARS);
        const view = makeView([longLine]);
        const ratio = createUniformRatioArray(1, 0.3);
        const result = splitChunkRange(chunkRange(0, 1), view, 1000, ratio);
        assert.equal(result.length, 1);
    });

    it('filters out entirely blank ranges', () => {
        const lines = ['', '   ', '\t', ''];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(4, 0.3);
        const result = splitChunkRange(chunkRange(0, 4), view, 1000, ratio);
        assert.equal(result.length, 0);
    });

    it('filters out boilerplate chunks', () => {
        const lines = createContentLines(3, 30);
        const view = makeView(lines);
        const ratio = createUniformRatioArray(3, 0.3);
        // Boilerplate filter that rejects everything
        const isBoilerplate = () => true;
        const result = splitChunkRange(chunkRange(0, 3), view, 1000, ratio, isBoilerplate);
        assert.equal(result.length, 0);
    });

    it('keeps non-boilerplate chunks when filter is provided', () => {
        const lines = createContentLines(3, 30);
        const view = makeView(lines);
        const ratio = createUniformRatioArray(3, 0.3);
        // Boilerplate filter that accepts everything
        const isBoilerplate = () => false;
        const result = splitChunkRange(chunkRange(0, 3), view, 1000, ratio, isBoilerplate);
        assert.equal(result.length, 1);
    });

    it('boilerplate filter receives content text without prefix', () => {
        const lines = createContentLines(3, 30);
        const view = makeView(lines);
        const ratio = createUniformRatioArray(3, 0.3);
        const prefix = 'PREFIX\n';
        let receivedText = '';
        const isBoilerplate = (text: string) => { receivedText = text; return false; };
        splitChunkRange(chunkRange(0, 3, prefix), view, 1000, ratio, isBoilerplate);
        assert.ok(!receivedText.startsWith(prefix),
            'Boilerplate filter should receive content without prefix');
    });

    // ── Prefix handling ─────────────────────────────────────────────────

    it('empty prefix produces chunk text equal to content', () => {
        const lines = createContentLines(3, 30);
        const view = makeView(lines);
        const ratio = createUniformRatioArray(3, 0.3);
        const result = splitChunkRange(chunkRange(0, 3, '', ''), view, 1000, ratio);
        assert.equal(result.length, 1);
        assert.equal(result[0].text, lines.join('\n'));
    });

    it('prefix is prepended to chunk text', () => {
        const lines = createContentLines(3, 30);
        const view = makeView(lines);
        const ratio = createUniformRatioArray(3, 0.3);
        const prefix = 'file: test.cpp\nclass Foo\n';
        const result = splitChunkRange(chunkRange(0, 3, prefix), view, 1000, ratio);
        assert.equal(result.length, 1);
        assert.equal(result[0].text, prefix + lines.join('\n'));
    });

    it('prefix consumes part of the token budget', () => {
        // Lines long enough to pass MIN_CHUNK_CHARS even with 1-2 per chunk
        const lines = createContentLines(20, 80);
        const view = makeView(lines);
        const ratio = createUniformRatioArray(20, 1.0);
        // Without prefix: budget = 500, each line ~81 tokens → ~6 lines per chunk
        const noPrefix = splitChunkRange(chunkRange(0, 20, '', ''), view, 500, ratio);
        // With large prefix (~200 chars * 1.0 = 200 tokens eaten from budget)
        const bigPrefix = 'x'.repeat(200) + '\n';
        const withPrefix = splitChunkRange(chunkRange(0, 20, bigPrefix, bigPrefix), view, 500, ratio);
        // With prefix, fewer lines per chunk → more chunks
        assert.ok(withPrefix.length > noPrefix.length,
            `With prefix: ${withPrefix.length} chunks should be > without: ${noPrefix.length}`);
    });

    // ── Sub-range ───────────────────────────────────────────────────────

    it('operates on sub-range of lines', () => {
        const lines = [...createContentLines(10, 20)];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(10, 0.3);
        // Only chunk lines 3-7
        const result = splitChunkRange(chunkRange(3, 7), view, 1000, ratio);
        assert.equal(result.length, 1);
        assert.equal(result[0].startLine, 3);
        assert.equal(result[0].endLine, 7);
        assert.equal(result[0].text, lines.slice(3, 7).join('\n'));
    });

    // ── Forward progress guarantee ──────────────────────────────────────

    it('makes forward progress even with very tight budget', () => {
        // Budget so tight that each chunk can only fit 1 line
        // Each line: (20+1)*1 = 21 tokens. Budget = 25.
        const lines = createContentLines(5, 80); // 80 chars each for MIN_CHUNK_CHARS
        const view = makeView(lines);
        const ratio = createUniformRatioArray(5, 1.0);
        const result = splitChunkRange(chunkRange(0, 5), view, 85, ratio);
        // Should produce chunks — not hang or crash
        assert.ok(result.length >= 1);
        // All lines should be covered
        if (result.length > 0) {
            assert.equal(result[result.length - 1].endLine, 5);
        }
    });

    // ── In-place compaction ─────────────────────────────────────────────

    it('compacts when some chunks are filtered and others kept', () => {
        // Mix of long and short content sections. The short ones should
        // be filtered (< MIN_CHUNK_CHARS), the long ones kept.
        // Create lines where some greedy chunks will be too short.
        const lines = [
            // First section: long enough
            ...createContentLines(5, 20),
            // Separator section: too short to be a chunk on its own
            'tiny',
            // Second section: long enough
            ...createContentLines(5, 20),
        ];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(lines.length, 1.0);
        // Budget tight enough to force splits near the separator
        const result = splitChunkRange(chunkRange(0, lines.length), view, 110, ratio);
        // All remaining chunks should have valid text
        for (const chunk of result) {
            assert.ok(chunk.text.length >= MIN_CHUNK_CHARS,
                `Chunk text length ${chunk.text.length} should be >= ${MIN_CHUNK_CHARS}`);
        }
    });

    // ── Line positions are 0-based exclusive end ────────────────────────

    it('chunk startLine and endLine use 0-based exclusive-end convention', () => {
        const lines = createContentLines(5, 30);
        const view = makeView(lines);
        const ratio = createUniformRatioArray(5, 0.3);
        const result = splitChunkRange(chunkRange(0, 5), view, 1000, ratio);
        assert.equal(result.length, 1);
        // 0-based inclusive start, 0-based exclusive end
        assert.equal(result[0].startLine, 0);
        assert.equal(result[0].endLine, 5);
        // The text should contain exactly lines 0 through 4
        const expectedText = lines.slice(0, 5).join('\n');
        assert.equal(result[0].text, expectedText);
    });

    // ── Ratio differences across lines ──────────────────────────────────

    it('respects varying per-line ratios when splitting', () => {
        // First 5 lines: low ratio (more chars per token → more lines fit)
        // Last 5 lines: high ratio (fewer chars per token → fewer lines fit)
        const lines = createContentLines(10, 20);
        const view = makeView(lines);
        const ratio = new Float32Array(10);
        ratio.fill(0.2, 0, 5);  // low density
        ratio.fill(2.0, 5, 10); // high density
        // Budget = 50
        // Lines 0-4 (low ratio): ~(21)*0.2 = 4.2 tokens each → all 5 fit easily = 21 tokens
        // Lines 5-9 (high ratio): ~(21)*2.0 = 42 tokens each → only ~1 fits
        const result = splitChunkRange(chunkRange(0, 10), view, 50, ratio);
        assert.ok(result.length === 2, 'Should split due to high-ratio lines');
    });

    // ── Multiple ranges don't interfere ─────────────────────────────────

    it('separate calls with different ranges produce independent results', () => {
        const lines = createContentLines(10, 30);
        const view = makeView(lines);
        const ratio = createUniformRatioArray(10, 0.3);
        const result1 = splitChunkRange(chunkRange(0, 5), view, 1000, ratio);
        const result2 = splitChunkRange(chunkRange(5, 10), view, 1000, ratio);
        assert.equal(result1.length, 1);
        assert.equal(result2.length, 1);
        assert.equal(result1[0].startLine, 0);
        assert.equal(result1[0].endLine, 5);
        assert.equal(result2[0].startLine, 5);
        assert.equal(result2[0].endLine, 10);
        // Texts should not overlap
        assert.notEqual(result1[0].text, result2[0].text);
    });

    // ── Prefix doesn't appear in content for boilerplate filter ─────────

    it('content text passed to boilerplate filter excludes prefix', () => {
        const lines = createContentLines(3, 30);
        const view = makeView(lines);
        const ratio = createUniformRatioArray(3, 0.3);
        const prefix = 'file: test.cpp\nclass Foo\n';
        const received: string[] = [];
        const isBoilerplate = (text: string) => { received.push(text); return false; };
        splitChunkRange(chunkRange(0, 3, prefix, prefix), view, 1000, ratio, isBoilerplate);
        assert.equal(received.length, 1);
        assert.equal(received[0], lines.join('\n'));
    });

    // ── Chunk text includes newlines between lines ──────────────────────

    it('chunk text joins content lines with newlines', () => {
        const lines = ['aaaa_' + 'x'.repeat(70), 'bbbb_' + 'y'.repeat(70)];
        const view = makeView(lines);
        const ratio = createUniformRatioArray(2, 0.1);
        const result = splitChunkRange(chunkRange(0, 2), view, 1000, ratio);
        assert.equal(result.length, 1);
        assert.ok(result[0].text.includes('\n'), 'Content lines should be joined with newlines');
        assert.equal(result[0].text, lines[0] + '\n' + lines[1]);
    });

    // ── Edge: all lines are blank ───────────────────────────────────────

    it('returns empty when all lines in range are blank', () => {
        const view = makeView(['', '', '', '', '']);
        const ratio = createUniformRatioArray(5, 0.3);
        const result = splitChunkRange(chunkRange(0, 5), view, 1000, ratio);
        assert.equal(result.length, 0);
    });

    // ── Edge: single line range ─────────────────────────────────────────

    it('handles single line range that meets MIN_CHUNK_CHARS', () => {
        const line = 'x'.repeat(MIN_CHUNK_CHARS);
        const view = makeView([line]);
        const ratio = createUniformRatioArray(1, 0.3);
        const result = splitChunkRange(chunkRange(0, 1), view, 1000, ratio);
        assert.equal(result.length, 1);
        assert.equal(result[0].text, line);
    });

    it('filters single line range below MIN_CHUNK_CHARS', () => {
        const line = 'x'.repeat(MIN_CHUNK_CHARS - 1);
        const view = makeView([line]);
        const ratio = createUniformRatioArray(1, 0.3);
        const result = splitChunkRange(chunkRange(0, 1), view, 1000, ratio);
        assert.equal(result.length, 0);
    });
});

// ── splitIntoChunks ─────────────────────────────────────────────────────────

describe('splitIntoChunks', () => {

    // Typical maxCharacters — generous enough for normal test content
    const MAX_CHARS = 2000;

    /**
     * Build a {@link ChunkingConfig} for tests. Hostname/port are
     * irrelevant when the tokenizer is mocked.
     */
    function makeConfig(maxTokens: number, maxCharacters: number = MAX_CHARS): ChunkingConfig {
        return {
            maxTokens,
            maxCharacters,
            tokenizerHostName: 'localhost',
            tokenizerPort: 0,
        };
    }

    afterEach(() => {
        clearTokenizerMock();
    });

    // ── Empty / degenerate inputs ───────────────────────────────────────

    it('returns empty array for empty chunkRanges', async () => {
        setUniformTokenizer(0.3);
        const result = await splitIntoChunks([], [], makeConfig(100));
        assert.equal(result.length, 0);
    });

    it('throws when maxCharacters < MAX_LINE_LENGTH', async () => {
        setUniformTokenizer(0.3);
        await assert.rejects(
            () => splitIntoChunks(['hello'], [chunkRange(0, 1)], makeConfig(100, MAX_LINE_LENGTH - 1)),
            /maxCharacters.*must be >= MAX_LINE_LENGTH/,
        );
    });

    // ── Single range, single chunk (no re-split) ────────────────────────

    it('produces a single chunk for a small range within budget', async () => {
        setUniformTokenizer(0.3);
        const lines = createContentLines(5, 99);
        const result = await splitIntoChunks(lines, [chunkRange(0, 5)], makeConfig(500));
        assert.equal(result.length, 1); // one range
        assert.equal(result[0].length, 1); // one chunk
        // 1-based inclusive start
        assert.equal(result[0][0].startLine, 1);
        assert.equal(result[0][0].endLine, 5);
        assert.equal(result[0][0].text, lines.join('\n'));
    });

    it('chunk text contains all content lines', async () => {
        setUniformTokenizer(0.3);
        const lines = createContentLines(3, 99);
        const result = await splitIntoChunks(lines, [chunkRange(0, 3)], makeConfig(500));
        assert.equal(result[0][0].text, lines.join('\n'));
    });

    it('chunk text includes prefix', async () => {
        setUniformTokenizer(0.3);
        const lines = createContentLines(3, 99);
        const prefix = 'file: test.cpp\n';
        const result = await splitIntoChunks(
            lines, [chunkRange(0, 3, prefix)], makeConfig(500),
        );
        assert.equal(result[0][0].text, prefix + lines.join('\n'));
    });

    // ── Multiple ranges ─────────────────────────────────────────────────

    it('returns one Chunk[] per ChunkRange in order', async () => {
        setUniformTokenizer(0.3);
        const lines = createContentLines(10, 99);
        const result = await splitIntoChunks(
            lines,
            [chunkRange(0, 5), chunkRange(5, 10)],
            makeConfig(500),
        );
        assert.equal(result.length, 2);
        assert.equal(result[0].length, 1);
        assert.equal(result[1].length, 1);
        // First range: 1-based lines 1-5
        assert.equal(result[0][0].startLine, 1);
        assert.equal(result[0][0].endLine, 5);
        // Second range: 1-based lines 6-10
        assert.equal(result[1][0].startLine, 6);
        assert.equal(result[1][0].endLine, 10);
    });

    it('empty ranges produce empty Chunk[] entries', async () => {
        setUniformTokenizer(0.3);
        const lines = createContentLines(5, 99);
        const result = await splitIntoChunks(
            lines,
            [chunkRange(0, 5), chunkRange(5, 5)], // second range is empty
            makeConfig(500),
        );
        assert.equal(result.length, 2);
        assert.equal(result[0].length, 1);
        assert.equal(result[1].length, 0);
    });

    // ── Multiple chunks per range ───────────────────────────────────────

    it('splits a large range into multiple chunks', async () => {
        // 30 lines of 99 chars each. maxTokens = maxCharacters = 1500.
        // initialTokensPerChar = 1500/1500 = 1.0, matches the mock ratio.
        // Each line: (99+1)*1.0 = 100 tokens. Budget = 1500 → 15 lines per chunk.
        // With OVERLAP_LINES = 10, forward progress = 5 lines per step.
        //
        // Greedy fill trace:
        // Chunk 0: [0, 15). Next current = max(15-10, 0+1) = 5
        // Chunk 1: [5, 20). Next current = max(20-10, 5+1) = 10
        // Chunk 2: [10, 25). Next current = max(25-10, 10+1) = 15
        // Chunk 3: [15, 30) → chunkEnd = 30 >= endLine, break
        // Reverse-fill: 15 lines from end = [15, 30). Same as last chunk → no dedup.
        //
        // Mock returns Math.round(text.length * 1.0). Each chunk is
        // 15 lines × 99 chars + 14 newlines = 1499 chars → 1499 tokens ≤ 1500. Within budget.
        setUniformTokenizer(1.0);
        const lines = createContentLines(30, 99);
        const result = await splitIntoChunks(
            lines, [chunkRange(0, 30)], makeConfig(1500, 1500),
        );
        assert.equal(result.length, 1); // one range
        assert.equal(result[0].length, 4);

        // Verify exact chunk boundaries (1-based inclusive)
        assert.equal(result[0][0].startLine, 1);
        assert.equal(result[0][0].endLine, 15);
        assert.equal(result[0][1].startLine, 6);
        assert.equal(result[0][1].endLine, 20);
        assert.equal(result[0][2].startLine, 11);
        assert.equal(result[0][2].endLine, 25);
        assert.equal(result[0][3].startLine, 16);
        assert.equal(result[0][3].endLine, 30);

        // Verify each chunk's text matches its line range
        // (1-based inclusive → 0-based: startLine-1 to endLine)
        for (const chunk of result[0]) {
            const expectedContent = lines.slice(chunk.startLine - 1, chunk.endLine).join('\n');
            assert.equal(chunk.text, expectedContent);
        }
    });

    it('converges in two rounds for uniform high-density content', async () => {
        // Simulates the infinite-loop scenario: uniform high-density content
        // (like hex byte arrays) where the initial tokens/char ratio
        // (maxTokens/maxCharacters ≈ 0.57) dramatically underestimates
        // the actual density (1.0 tokens/char).
        //
        // Round 1: initial ratio produces ~44-line chunks that tokenize
        //          to ~3563 tokens — all over the 2048 budget.
        // Round 2: corrected ratio (1.0) produces 25-line chunks that
        //          tokenize to 2024 tokens — all within budget.
        const line = '0123456789'.repeat(8); // 80 chars
        const lines = Array(200).fill(line);

        let callCount = 0;
        setGetTokenCountsMock(async (contents) => {
            callCount++;
            // Each character (including newlines) is exactly 1 token
            return contents.map(c => c.length);
        });

        const result = await splitIntoChunks(
            lines, [chunkRange(0, 200)], makeConfig(2048, 3584));

        // Should converge in exactly 2 tokenization rounds
        assert.equal(callCount, 2, 'Should need exactly 2 tokenization rounds');

        const chunks = result[0];
        assert.ok(chunks.length > 1, 'Should produce multiple chunks');

        // All chunks should be within budget
        for (const chunk of chunks) {
            assert.ok(chunk.text.length <= 2048,
                `Chunk [${chunk.startLine},${chunk.endLine}) has ${chunk.text.length} tokens, exceeds budget 2048`);
        }

        // All non-last chunks should contain the maximum content that fits:
        // 25 lines × 80 chars + 24 newlines = 2024 chars = 2024 tokens.
        // (Not 2048 because getText joins N lines with N-1 newlines, while
        // the estimator charges +1 per line including the last.)
        const expectedTokens = 25 * 80 + 24; // 2024
        for (let i = 0; i < chunks.length - 1; i++) {
            assert.equal(chunks[i].text.length, expectedTokens,
                `Chunk ${i} should have ${expectedTokens} tokens (25 lines × 80 chars + 24 newlines)`);
        }
    });

    it('uses primaryPrefix for first chunk, secondaryPrefix for rest', async () => {
        setUniformTokenizer(0.3);
        const lines = createContentLines(30, 99);
        const primary = 'PRIMARY\n';
        const secondary = 'SECONDARY\n';
        const result = await splitIntoChunks(
            lines, [chunkRange(0, 30, primary, secondary)], makeConfig(500),
        );
        assert.ok(result[0].length >= 2);
        assert.ok(result[0][0].text.startsWith(primary));
        for (let i = 1; i < result[0].length; i++) {
            assert.ok(result[0][i].text.startsWith(secondary),
                `Chunk ${i} should start with secondary prefix`);
        }
    });

    // ── 1-based line number conversion ──────────────────────────────────

    it('converts chunk positions to 1-based inclusive', async () => {
        setUniformTokenizer(0.3);
        const lines = createContentLines(5, 99);
        const result = await splitIntoChunks(
            lines, [chunkRange(0, 5)], makeConfig(500),
        );
        const chunk = result[0][0];
        // 0-based [0, 5) → 1-based start=1, end=5 (inclusive)
        assert.equal(chunk.startLine, 1);
        assert.equal(chunk.endLine, 5);
    });

    // ── Tokenization error handling ─────────────────────────────────────

    it('throws when tokenizer returns -1', async () => {
        setGetTokenCountsMock(async (contents) =>
            contents.map(() => -1),
        );
        const lines = createContentLines(5, 99);
        await assert.rejects(
            () => splitIntoChunks(lines, [chunkRange(0, 5)], makeConfig(500)),
            /Tokenization failed/,
        );
    });

    // ── Iterative ratio correction ──────────────────────────────────────

    it('re-splits over-budget chunks using corrected ratios', async () => {
        // Mock: first call returns over-budget counts for some chunks,
        // second call returns within-budget counts.
        let callCount = 0;
        setGetTokenCountsMock(async (contents) => {
            callCount++;
            if (callCount === 1) {
                // First pass: return over-budget for all chunks
                return contents.map(() => 600);
            }
            // Subsequent passes: return within-budget
            return contents.map(() => 100);
        });
        const lines = createContentLines(30, 99);
        const result = await splitIntoChunks(
            lines, [chunkRange(0, 30)], makeConfig(500),
        );
        // Should have called getTokenCounts at least twice
        assert.ok(callCount >= 2,
            `Expected >= 2 tokenization rounds, got ${callCount}`);
        // Should still produce valid chunks
        assert.ok(result[0].length >= 1);
        assert.equal(result[0][0].startLine, 1);
        assert.equal(result[0][result[0].length - 1].endLine, 30);
    });

    it('only re-tokenizes affected ranges on correction', async () => {
        // Two ranges: range 0 is within budget, range 1 is over budget.
        // After correction, only range 1's chunks should be re-tokenized.
        const lines = createContentLines(20, 99);
        const callTexts: string[][] = [];

        let callCount = 0;
        setGetTokenCountsMock(async (contents) => {
            callTexts.push([...contents]);
            callCount++;
            if (callCount === 1) {
                // First pass: first range's chunk is within budget (50),
                // second range's chunks are over budget (600).
                return [50, ...contents.slice(1).map(() => 600)];
            }
            // Subsequent passes: all within budget
            return contents.map(() => 100);
        });

        const result = await splitIntoChunks(
            lines,
            [chunkRange(0, 5), chunkRange(5, 20)],
            makeConfig(500),
        );

        assert.ok(callCount >= 2);
        assert.equal(result.length, 2);
        assert.equal(result[0].length, 1);
        assert.ok(result[1].length >= 1);

        // Range 0's chunk should be unchanged
        assert.equal(result[0][0].startLine, 1);
        assert.equal(result[0][0].endLine, 5);
        const range0Text = result[0][0].text;

        assert.ok(callTexts[0].includes(range0Text),
            'First tokenization call should include range 0\'s chunk text');

        // The second tokenization call should NOT contain range 0's chunk text.
        // If it did, that means range 0 was unnecessarily re-tokenized.
        assert.ok(!callTexts[1].includes(range0Text),
            'Second tokenization call should not include range 0\'s chunk text');
    });

    it('ratios only increase after correction (Math.max)', async () => {
        // Track the chunks passed to each tokenization call to verify
        // that over-budget chunks get smaller (more chunks) on re-split.
        let callCount = 0;
        const chunkCountsPerCall: number[] = [];

        setGetTokenCountsMock(async (contents) => {
            callCount++;
            chunkCountsPerCall.push(contents.length);
            if (callCount === 1) {
                // First pass: all over budget
                return contents.map(() => 600);
            }
            // All within budget after correction
            return contents.map(() => 100);
        });

        const lines = createContentLines(30, 99);
        await splitIntoChunks(
            lines, [chunkRange(0, 30)], makeConfig(500),
        );

        assert.ok(callCount === 2);
        // After ratio correction, re-split should produce more chunks
        // (smaller chunks due to higher per-line ratio)
        assert.ok(chunkCountsPerCall[1] > chunkCountsPerCall[0],
            `Re-split should produce > as many chunks: ` +
            `${chunkCountsPerCall[1]} should be >= ${chunkCountsPerCall[0]}`);
    });

    // ── Convergence ─────────────────────────────────────────────────────

    it('converges when mock always returns within budget', async () => {
        setUniformTokenizer(0.1); // very low ratio → always within budget
        const lines = createContentLines(50, 99);
        const result = await splitIntoChunks(
            lines, [chunkRange(0, 50)], makeConfig(500),
        );
        // Should produce valid output without infinite looping
        assert.ok(result[0].length >= 1);
        assert.equal(result[0][0].startLine, 1);
        assert.equal(result[0][result[0].length - 1].endLine, 50);
    });

    it('converges with multiple rounds of correction', async () => {
        // Simulate a scenario where 3 rounds are needed:
        // Round 1: all over budget at 800
        // Round 2: still over budget at 600 (ratio improved but not enough)
        // Round 3: within budget at 200
        let callCount = 0;
        setGetTokenCountsMock(async (contents) => {
            callCount++;
            if (callCount === 1) return contents.map(() => 800);
            if (callCount === 2) return contents.map(() => 600);
            return contents.map(() => 200);
        });

        const lines = createContentLines(30, 99);
        const result = await splitIntoChunks(
            lines, [chunkRange(0, 30)], makeConfig(500),
        );

        assert.equal(callCount, 3);
        assert.ok(result[0].length >= 1);
    });

    // ── SplitLineView integration (long lines) ──────────────────────────

    it('handles lines longer than MAX_LINE_LENGTH via SplitLineView', async () => {
        // Use a low mock ratio so everything fits in one chunk for exact matching.
        setUniformTokenizer(0.1);
        // One very long line that SplitLineView will split into virtual lines
        const longLine = 'word '.repeat(100); // ~500 chars, well over MAX_LINE_LENGTH
        const lines = [longLine, ...createContentLines(3, 99)];
        const result = await splitIntoChunks(
            lines, [chunkRange(0, 4)], makeConfig(500),
        );
        assert.equal(result.length, 1);
        assert.equal(result[0].length, 1);
        // Source line numbers should reference the original 4 lines, not virtual sub-lines
        assert.equal(result[0][0].startLine, 1);
        assert.equal(result[0][0].endLine, 4);
        // The chunk text should exactly match all original lines joined with newlines.
        // SplitLineView splits the long line internally but getText() reconstructs it.
        assert.equal(result[0][0].text, lines.join('\n'));
    });

    it('virtual→source conversion produces correct line numbers for split lines', async () => {
        setUniformTokenizer(0.1); // low ratio so everything fits
        // Line 0: short, Line 1: very long, Line 2: short
        const lines = [
            'x'.repeat(99),
            'y '.repeat(200), // ~400 chars, will be split by SplitLineView
            'z'.repeat(99),
        ];
        const result = await splitIntoChunks(
            lines, [chunkRange(0, 3)], makeConfig(5000),
        );
        assert.equal(result.length, 1);
        assert.equal(result[0].length, 1);
        // 1-based: covers all 3 source lines
        assert.equal(result[0][0].startLine, 1);
        assert.equal(result[0][0].endLine, 3);
    });

    // ── Boilerplate filtering ───────────────────────────────────────────

    it('filters boilerplate chunks before tokenization', async () => {
        const tokenizedTexts: string[][] = [];
        setGetTokenCountsMock(async (contents) => {
            tokenizedTexts.push([...contents]);
            return contents.map(() => 50);
        });

        const lines = createContentLines(5, 99);
        // Boilerplate filter that rejects everything
        const result = await splitIntoChunks(
            lines, [chunkRange(0, 5)], makeConfig(500),
            () => true, // all boilerplate
        );

        assert.equal(result[0].length, 0);
        // Nothing should have been tokenized since all chunks were filtered
        assert.equal(tokenizedTexts.length, 0);
    });

    it('keeps non-boilerplate chunks', async () => {
        setUniformTokenizer(0.3);
        const lines = createContentLines(5, 99);
        const result = await splitIntoChunks(
            lines, [chunkRange(0, 5)], makeConfig(500),
            () => false, // nothing is boilerplate
        );
        assert.ok(result[0].length >= 1);
    });

    // ── Chunk text content integrity ────────────────────────────────────

    it('all chunks have non-empty text', async () => {
        setUniformTokenizer(0.3);
        const lines = createContentLines(30, 99);
        const result = await splitIntoChunks(
            lines, [chunkRange(0, 30)], makeConfig(500),
        );
        for (const chunks of result) {
            for (const chunk of chunks) {
                assert.ok(chunk.text.length > 0, 'Chunk text should not be empty');
                assert.ok(chunk.text.length >= MIN_CHUNK_CHARS,
                    `Chunk text length ${chunk.text.length} should be >= ${MIN_CHUNK_CHARS}`);
            }
        }
    });

    it('all chunks have sha256 as empty string', async () => {
        setUniformTokenizer(0.3);
        const lines = createContentLines(5, 99);
        const result = await splitIntoChunks(
            lines, [chunkRange(0, 5)], makeConfig(500),
        );
        for (const chunk of result[0]) {
            assert.equal(chunk.sha256, '');
        }
    });

    // ── Chunks filtered by MIN_CHUNK_CHARS ──────────────────────────────

    it('filters out chunks below MIN_CHUNK_CHARS', async () => {
        setUniformTokenizer(0.3);
        // Very short lines that won't meet MIN_CHUNK_CHARS
        const lines = ['ab', 'cd', 'ef'];
        const result = await splitIntoChunks(
            lines, [chunkRange(0, 3)], makeConfig(500),
        );
        assert.equal(result[0].length, 0);
    });

    // ── Blank line trimming ─────────────────────────────────────────────

    it('trims blank lines from chunk boundaries', async () => {
        setUniformTokenizer(0.3);
        const lines = ['', '', ...createContentLines(3, 99), '', ''];
        const result = await splitIntoChunks(
            lines, [chunkRange(0, 7)], makeConfig(500),
        );
        assert.equal(result[0].length, 1);
        // 1-based: should start at line 3 (skipping 2 blanks), end at line 5
        assert.equal(result[0][0].startLine, 3);
        assert.equal(result[0][0].endLine, 5);
    });

    // ── Single-line over-budget termination ─────────────────────────────

    it('drops a single-line chunk that exceeds budget', async () => {
        // A single content line whose token count always exceeds the budget.
        // The algorithm cannot shrink below 1 line, so it should drop the
        // chunk entirely rather than looping forever.
        setGetTokenCountsMock(async (contents) =>
            contents.map(() => 9999), // always over budget
        );
        const lines = [createContentLines(1, 99)[0]];
        const result = await splitIntoChunks(
            lines, [chunkRange(0, 1)], makeConfig(500),
        );
        assert.equal(result.length, 1);
        assert.equal(result[0].length, 0, 'Single-line over-budget chunk should be dropped');
    });

    it('drops only the single-line over-budget chunk from a multi-chunk range', async () => {
        // Multiple content lines where one always exceeds the budget when
        // it's the sole content line in a chunk. The mock returns c.length
        // (1 token per char), which at 99 chars/line produces ~100 tokens
        // per line. With budget = 105, only 1 line fits per chunk.
        // The over-budget line gets its own chunk and is dropped.
        const overBudgetLine = 'OVER_BUDGET_' + 'z'.repeat(87); // 99 chars
        const lines = [
            ...createContentLines(2, 99),
            overBudgetLine,
            ...createContentLines(2, 99),
        ];

        setGetTokenCountsMock(async (contents) => {
            return contents.map(text => {
                if (text.includes(overBudgetLine)) {
                    return 9999; // always over budget
                }
                return text.length; // 1 token per char
            });
        });

        const result = await splitIntoChunks(
            lines, [chunkRange(0, 5)], makeConfig(105),
        );

        // The over-budget line should not appear in any surviving chunk
        assert.equal(result.length, 1, 'Should have exactly 1 range of chunks');
        assert.equal(result[0].length, 4, 'Should drop exactly the over-budget single-line chunk');
        assert.equal(result[0][0].text, lines[0]);
        assert.equal(result[0][1].text, lines[1]);
        assert.equal(result[0][2].text, lines[3]);
        assert.equal(result[0][3].text, lines[4]);
    });
});
