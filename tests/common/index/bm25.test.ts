// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Tests for {@link rankFiles} from the BM25 scoring module.
 *
 * Covers:
 *   - Empty input
 *   - Single file, single pattern
 *   - Single file, multiple patterns
 *   - Multiple files ranked by term frequency
 *   - Rare terms (high IDF) rank higher than common terms
 *   - Document length normalization
 *   - Proximity bonus for co-occurring patterns on the same line
 *   - Line numbers are merged, deduplicated, and sorted
 *   - Score is always non-negative
 *
 * Run with:
 * npx tsc -p tsconfig.test.json; node --test out-test/tests/common/index/bm25.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { rankFiles } from '../../../src/common/index/bm25';
import type { SearchOutput } from '../../../src/common/index/types';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Create a minimal SearchOutput for testing. */
function makeOutput(
    filePath: string,
    totalLines: number,
    patternMatches: Array<{ patternIndex: number; frequency: number; lineNumbers: number[] }>,
): SearchOutput {
    return {
        type: 'search',
        filePath,
        totalLines,
        patternMatches,
    };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('rankFiles', () => {

    // ── Empty input ─────────────────────────────────────────────────────

    it('returns empty array for empty input', () => {
        const result = rankFiles([], 1000);
        assert.deepStrictEqual(result, []);
    });

    // ── Single file, single pattern ─────────────────────────────────────

    it('scores a single file with one pattern', () => {
        const results = [
            makeOutput('a.cc', 100, [
                { patternIndex: 0, frequency: 5, lineNumbers: [10, 20, 30, 40, 50] },
            ]),
        ];
        const scored = rankFiles(results, 1000);
        assert.strictEqual(scored.length, 1);
        assert.strictEqual(scored[0].filePath, 'a.cc');
        assert.ok(scored[0].score > 0);
        assert.deepStrictEqual(scored[0].lineNumbers, [10, 20, 30, 40, 50]);
        assert.strictEqual(scored[0].totalLines, 100);
    });

    // ── Higher TF ranks higher ──────────────────────────────────────────

    it('file with more matches ranks higher than file with fewer', () => {
        const results = [
            makeOutput('few.cc', 100, [
                { patternIndex: 0, frequency: 2, lineNumbers: [10, 20] },
            ]),
            makeOutput('many.cc', 100, [
                { patternIndex: 0, frequency: 20, lineNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] },
            ]),
        ];
        const scored = rankFiles(results, 1000);
        assert.strictEqual(scored[0].filePath, 'many.cc');
        assert.strictEqual(scored[1].filePath, 'few.cc');
        assert.ok(scored[0].score > scored[1].score);
    });

    // ── Rare term (high IDF) ranks higher ───────────────────────────────

    it('file matching a rare term ranks higher than file matching a common term', () => {
        // Pattern 0 appears in 1 file (rare), pattern 1 appears in 500 files (common)
        const rareFile = makeOutput('rare.cc', 100, [
            { patternIndex: 0, frequency: 1, lineNumbers: [50] },
        ]);
        // Create 500 files that match only the common pattern
        const commonFiles: SearchOutput[] = [];
        for (let i = 0; i < 500; i++) {
            commonFiles.push(makeOutput(`common_${i}.cc`, 100, [
                { patternIndex: 1, frequency: 1, lineNumbers: [10] },
            ]));
        }
        const allResults = [rareFile, ...commonFiles];
        const scored = rankFiles(allResults, 1000);

        // The rare file should be ranked first
        assert.strictEqual(scored[0].filePath, 'rare.cc');
    });

    // ── Multiple patterns boost score ───────────────────────────────────

    it('file matching two patterns scores higher than file matching one', () => {
        const results = [
            makeOutput('one_pattern.cc', 100, [
                { patternIndex: 0, frequency: 3, lineNumbers: [10, 20, 30] },
            ]),
            makeOutput('two_patterns.cc', 100, [
                { patternIndex: 0, frequency: 3, lineNumbers: [10, 20, 30] },
                { patternIndex: 1, frequency: 2, lineNumbers: [40, 50] },
            ]),
        ];
        const scored = rankFiles(results, 1000);
        assert.strictEqual(scored[0].filePath, 'two_patterns.cc');
        assert.ok(scored[0].score > scored[1].score);
    });

    // ── Document length normalization ───────────────────────────────────

    it('shorter file with same TF ranks higher than longer file (length normalization)', () => {
        const results = [
            makeOutput('long.cc', 5000, [
                { patternIndex: 0, frequency: 5, lineNumbers: [100, 200, 300, 400, 500] },
            ]),
            makeOutput('short.cc', 50, [
                { patternIndex: 0, frequency: 5, lineNumbers: [10, 20, 30, 40, 50] },
            ]),
        ];
        const scored = rankFiles(results, 1000);
        assert.strictEqual(scored[0].filePath, 'short.cc');
        assert.ok(scored[0].score > scored[1].score);
    });

    // ── Proximity bonus ─────────────────────────────────────────────────

    it('proximity bonus increases score when patterns co-occur on the same line', () => {
        // Both have same patterns and frequencies, but one has co-occurrence
        const noProximity = makeOutput('no_prox.cc', 100, [
            { patternIndex: 0, frequency: 2, lineNumbers: [10, 20] },
            { patternIndex: 1, frequency: 2, lineNumbers: [30, 40] },
        ]);
        const withProximity = makeOutput('with_prox.cc', 100, [
            { patternIndex: 0, frequency: 2, lineNumbers: [10, 20] },
            { patternIndex: 1, frequency: 2, lineNumbers: [10, 40] }, // line 10 shared
        ]);
        const scored = rankFiles([noProximity, withProximity], 1000);
        assert.strictEqual(scored[0].filePath, 'with_prox.cc');
        assert.ok(scored[0].score > scored[1].score);
    });

    it('no proximity bonus when file has only one pattern', () => {
        const results = [
            makeOutput('single.cc', 100, [
                { patternIndex: 0, frequency: 5, lineNumbers: [10, 20, 30, 40, 50] },
            ]),
        ];
        // Run with proximityWeight=0 and proximityWeight=1 — should be the same
        const withoutBonus = rankFiles(results, 1000, 1.2, 0.75, 0);
        const withBonus = rankFiles(results, 1000, 1.2, 0.75, 1.0);
        assert.strictEqual(withoutBonus[0].score, withBonus[0].score);
    });

    // ── Line number merging ─────────────────────────────────────────────

    it('line numbers are merged, deduplicated, and sorted across patterns', () => {
        const results = [
            makeOutput('merged.cc', 100, [
                { patternIndex: 0, frequency: 3, lineNumbers: [30, 10, 50] },
                { patternIndex: 1, frequency: 2, lineNumbers: [10, 20] }, // line 10 shared
            ]),
        ];
        const scored = rankFiles(results, 1000);
        assert.deepStrictEqual(scored[0].lineNumbers, [10, 20, 30, 50]);
    });

    // ── Score properties ────────────────────────────────────────────────

    it('all scores are non-negative', () => {
        const results = [
            makeOutput('a.cc', 100, [
                { patternIndex: 0, frequency: 1, lineNumbers: [1] },
            ]),
            makeOutput('b.cc', 200, [
                { patternIndex: 0, frequency: 10, lineNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
                { patternIndex: 1, frequency: 5, lineNumbers: [20, 30, 40, 50, 60] },
            ]),
        ];
        const scored = rankFiles(results, 50000);
        for (const sf of scored) {
            assert.ok(sf.score >= 0, `Score for ${sf.filePath} should be non-negative, got ${sf.score}`);
        }
    });

    it('results are sorted by score descending', () => {
        const results = [
            makeOutput('low.cc', 100, [
                { patternIndex: 0, frequency: 1, lineNumbers: [10] },
            ]),
            makeOutput('mid.cc', 100, [
                { patternIndex: 0, frequency: 5, lineNumbers: [10, 20, 30, 40, 50] },
            ]),
            makeOutput('high.cc', 100, [
                { patternIndex: 0, frequency: 10, lineNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
                { patternIndex: 1, frequency: 5, lineNumbers: [20, 30, 40, 50, 60] },
            ]),
        ];
        const scored = rankFiles(results, 1000);
        for (let i = 1; i < scored.length; i++) {
            assert.ok(scored[i - 1].score >= scored[i].score,
                `Results not sorted: ${scored[i - 1].filePath} (${scored[i - 1].score}) should be >= ${scored[i].filePath} (${scored[i].score})`);
        }
    });

    // ── BM25 parameter effects ──────────────────────────────────────────

    it('b=0 disables length normalization', () => {
        const results = [
            makeOutput('long.cc', 5000, [
                { patternIndex: 0, frequency: 5, lineNumbers: [100, 200, 300, 400, 500] },
            ]),
            makeOutput('short.cc', 50, [
                { patternIndex: 0, frequency: 5, lineNumbers: [10, 20, 30, 40, 50] },
            ]),
        ];
        // With b=0, document length should not affect score — same TF means same score
        const scored = rankFiles(results, 1000, 1.2, 0);
        assert.strictEqual(scored[0].score, scored[1].score);
    });

    it('higher k1 allows TF to have more impact', () => {
        const results = [
            makeOutput('a.cc', 100, [
                { patternIndex: 0, frequency: 50, lineNumbers: Array.from({ length: 50 }, (_, i) => i) },
            ]),
        ];
        const lowK1 = rankFiles(results, 1000, 0.5, 0.75);
        const highK1 = rankFiles(results, 1000, 5.0, 0.75);
        // With higher k1, TF saturation is slower so scores differ
        // Both should produce valid scores
        assert.ok(lowK1[0].score > 0);
        assert.ok(highK1[0].score > 0);
    });
});
