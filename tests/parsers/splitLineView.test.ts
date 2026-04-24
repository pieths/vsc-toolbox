// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Tests for the {@link SplitLineView} class.
 *
 * This test can be run from the command line with:
 * npx tsc -p tsconfig.test.json; node --test out-test/tests/parsers/splitLineView.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SplitLineView } from '../../src/common/index/parsers/splitLineView';

// ── Constructor / Fast Path ─────────────────────────────────────────────────

describe('SplitLineView constructor', () => {
    it('handles empty lines array', () => {
        const view = new SplitLineView([], 100);
        assert.equal(view.lineCount, 0);
    });

    it('handles single short line', () => {
        const view = new SplitLineView(['hello'], 100);
        assert.equal(view.lineCount, 1);
        assert.equal(view.getLine(0), 'hello');
    });

    it('passes through lines that are all within maxLineChars (fast path)', () => {
        const lines = ['short', 'also short', 'fine'];
        const view = new SplitLineView(lines, 100);
        assert.equal(view.lineCount, 3);
        assert.equal(view.getLine(0), 'short');
        assert.equal(view.getLine(1), 'also short');
        assert.equal(view.getLine(2), 'fine');
    });

    it('handles lines exactly at maxLineChars (no split)', () => {
        const line = 'x'.repeat(50);
        const view = new SplitLineView([line], 50);
        assert.equal(view.lineCount, 1);
        assert.equal(view.getLine(0), line);
    });
});

// ── Line Splitting ──────────────────────────────────────────────────────────

describe('SplitLineView line splitting', () => {
    it('splits a single long line on space boundary', () => {
        // 'aaa bbb ccc ddd eee' with maxLineChars=10
        // Space-split segments include the trailing space in the first segment
        const view = new SplitLineView(['aaa bbbb ccc dddd eee'], 10);
        assert.ok(view.lineCount === 3, `Expected 3 lines, got ${view.lineCount}`);
        // Each virtual line must be <= maxLineChars
        for (let i = 0; i < view.lineCount; i++) {
            assert.ok(
                view.getLineLength(i) <= 10,
                `Virtual line ${i} is ${view.getLineLength(i)} chars: "${view.getLine(i)}"`,
            );
        }

        assert.equal(view.getLine(0), 'aaa bbbb ');
        assert.equal(view.getLine(1), 'ccc dddd ');
        assert.equal(view.getLine(2), 'eee');

        // Reconstruction should match original
        assert.equal(view.getText(0, view.lineCount), 'aaa bbbb ccc dddd eee');

        // Test space split where space is within the 80% zone.
        // 'aaabbbcccdddd eee' (18 chars) with maxLineChars=16.
        // Space at index 13, threshold is 16*0.8=12.8, so 13 >= 12.8 → space split.
        // Segment includes trailing space: 'aaabbbcccdddd ' (14 chars, <= 16).
        const view2 = new SplitLineView(['aaabbbcccdddeeefffggg eeee'], 25);
        assert.ok(view2.lineCount === 2, `Expected 2 lines, got ${view2.lineCount}`);
        assert.equal(view2.getLine(0), 'aaabbbcccdddeeefffggg ');
        assert.equal(view2.getLine(1), 'eeee');
        assert.equal(view2.getText(0, view2.lineCount), 'aaabbbcccdddeeefffggg eeee');
    });

    it('no virtual line exceeds maxLineChars (contract)', () => {
        const maxLineChars = 15;
        const lines = [
            'short',
            'a line with spaces that is quite long and will be split',
            'abcdefghijklmnopqrstuvwxyz0123456789', // no spaces
            'word ' + 'x'.repeat(30), // space early then long run
        ];
        const view = new SplitLineView(lines, maxLineChars);
        for (let i = 0; i < view.lineCount; i++) {
            assert.ok(
                view.getLineLength(i) <= maxLineChars,
                `Virtual line ${i} exceeds maxLineChars (${view.getLineLength(i)}): "${view.getLine(i)}"`,
            );
        }
        // Full reconstruction should still match
        assert.equal(view.getText(0, view.lineCount), lines.join('\n'));
    });

    it('splits on character boundary when no suitable space found', () => {
        // A line with no spaces at all
        const line = 'abcdefghijklmnopqrstuvwxyz';
        const view = new SplitLineView([line], 10);
        assert.ok(view.lineCount > 1);
        // First segment should be exactly 10 chars (character boundary)
        assert.equal(view.getLineLength(0), 10);
        assert.equal(view.getLine(0), 'abcdefghij');
        assert.equal(view.getLineLength(1), 10);
        assert.equal(view.getLine(1), 'klmnopqrst');
        assert.equal(view.getLineLength(2), 6);
        assert.equal(view.getLine(2), 'uvwxyz');
    });

    it('splits on character boundary when space is too far back (< 80%)', () => {
        // Space at position 1, but maxLineChars=10, so 1 < 10*0.8=8
        const line = 'a bcdefghijklmnop';
        const view = new SplitLineView([line], 10);
        // Should split on character boundary since the space is too far back
        assert.equal(view.getLine(0), 'a bcdefghi');
        assert.equal(view.getLine(1), 'jklmnop');
    });

    it('preserves short lines between long lines', () => {
        const lines = [
            'a'.repeat(20) + ' ' + 'b'.repeat(20),  // long line
            'short',                                    // short line
            'c'.repeat(20) + ' ' + 'd'.repeat(20),  // long line
        ];
        const view = new SplitLineView(lines, 25);
        assert.equal(view.lineCount, 5, `Expected 5 virtual lines, got ${view.lineCount}`);
        // The short line should appear as a virtual line
        let foundShort = false;
        for (let i = 0; i < view.lineCount; i++) {
            if (view.getLine(i) === 'short') {
                foundShort = true;
                break;
            }
        }
        assert.ok(foundShort, 'Short line between long lines was not preserved');
    });

    it('handles multiple long lines in sequence', () => {
        const lines = [
            'word1 word2 word3 word4 word5',
            'word6 word7 word8 word9 word10',
        ];
        const view = new SplitLineView(lines, 12);
        // All virtual lines should be <= 12 chars
        for (let i = 0; i < view.lineCount; i++) {
            assert.ok(
                view.getLineLength(i) <= 12,
                `Virtual line ${i} is ${view.getLineLength(i)} chars`,
            );
        }
        assert.equal(view.getText(0, view.lineCount), lines.join('\n'));
    });

    it('handles a line that is exactly one char over maxLineChars', () => {
        const line = 'a'.repeat(11);
        const view = new SplitLineView([line], 10);
        assert.equal(view.lineCount, 2);
        assert.equal(view.getLineLength(0), 10);
        assert.equal(view.getLineLength(1), 1);
    });

    it('handles line with consecutive spaces', () => {
        // 'hello     world' (15 chars) with maxLineChars=10.
        // lastIndexOf(' ', 9) finds space at index 9 (within the run of spaces).
        // 9 >= 10*0.8=8 → space split. Segment includes trailing space.
        const line = 'hello     world';
        const view = new SplitLineView([line], 10);
        assert.equal(view.lineCount, 2);
        assert.equal(view.getLine(0), 'hello     ');
        assert.equal(view.getLine(1), 'world');
        assert.equal(view.getText(0, view.lineCount), line);
    });

    it('handles line with only spaces', () => {
        const line = ' '.repeat(30);
        const view = new SplitLineView([line], 10);
        assert.ok(view.lineCount == 3);
        assert.equal(view.getLine(0), ' '.repeat(10));
        assert.equal(view.getLine(1), ' '.repeat(10));
        assert.equal(view.getLine(2), ' '.repeat(10));
        assert.equal(view.getText(0, view.lineCount), line);
    });
});

// ── getLine / getLineLength ─────────────────────────────────────────────────

describe('SplitLineView getLine / getLineLength', () => {
    it('getLineLength matches getLine().length', () => {
        const lines = ['short line', 'a much longer line that should be split into parts'];
        const view = new SplitLineView(lines, 15);
        for (let i = 0; i < view.lineCount; i++) {
            assert.equal(
                view.getLineLength(i),
                view.getLine(i).length,
                `Mismatch at virtual line ${i}`,
            );
        }
    });
});

// ── getText ─────────────────────────────────────────────────────────────────

describe('SplitLineView getText', () => {
    it('returns empty string for empty range', () => {
        const view = new SplitLineView(['hello'], 100);
        assert.equal(view.getText(0, 0), '');
        assert.equal(view.getText(1, 0), '');
    });

    it('returns single line for range of 1', () => {
        const view = new SplitLineView(['hello', 'world'], 100);
        assert.equal(view.getText(0, 1), 'hello');
        assert.equal(view.getText(1, 2), 'world');
    });

    it('joins unsplit lines with newlines (fast path)', () => {
        const lines = ['line1', 'line2', 'line3'];
        const view = new SplitLineView(lines, 100);
        assert.equal(view.getText(0, 3), 'line1\nline2\nline3');
    });

    it('joins unsplit lines subset with newlines', () => {
        const lines = ['a', 'b', 'c', 'd'];
        const view = new SplitLineView(lines, 100);
        assert.equal(view.getText(1, 3), 'b\nc');
    });

    it('uses space separator for space-split segments', () => {
        const line = 'hello world foo bar';
        const view = new SplitLineView([line], 13);
        assert.equal(view.lineCount, 2);
        // Reconstruct should use spaces between segments of the same line
        const fullText = view.getText(0, view.lineCount);
        // The reconstructed text should equal the original
        assert.equal(fullText, line);
    });

    it('uses no separator for character-split segments', () => {
        const line = 'abcdefghijklmnopqrstuvwxyz';
        const view = new SplitLineView([line], 10);
        // Reconstruct should concatenate directly (no spaces in original)
        const fullText = view.getText(0, view.lineCount);
        assert.equal(fullText, line);
    });

    it('uses newline between different source lines', () => {
        const lines = ['short1', 'short2'];
        const view = new SplitLineView(
            ['this is a longer line that splits', ...lines],
            15
        );
        // The last two virtual lines should be joined by newline
        const lastTwo = view.getText(view.lineCount - 2, view.lineCount);
        assert.equal(lastTwo, 'short1\nshort2');
    });

    it('correctly mixes newlines and spaces in reconstruction', () => {
        const lines = [
            'hello world foo bar',  // will be split with spaces
            'separate line',        // newline before this
        ];
        const view = new SplitLineView(lines, 12);
        const fullText = view.getText(0, view.lineCount);
        assert.equal(fullText, lines.join('\n'));
        assert.equal(view.getText(0, 1), 'hello world ');
        assert.equal(view.getText(1, 2), 'foo bar');
        assert.equal(view.getText(2, 3), 'separate lin');
        assert.equal(view.getText(3, 4), 'e');
        assert.equal(view.getText(1, 3), 'foo bar\nseparate lin');
    });

    it('reconstructs entire file correctly with mixed content', () => {
        const lines = [
            'short',
            'another short line',
            'a very long line with many words that will be split into multiple segments',
            'end line with over 20 characters',
        ];
        const view = new SplitLineView(lines, 20);
        const fullText = view.getText(0, view.lineCount);
        assert.equal(fullText, lines.join('\n'));

        const range = view.getVirtualRange(2, 3);
        assert.ok(range[1] - range[0] > 1, 'Expected source line 2 to split into multiple virtual lines');
        assert.equal(view.getText(range[0], range[1]), lines[2],
            'Reconstructed text for source line 2 does not match original');
    });
});

// ── getSourceRange ──────────────────────────────────────────────────────────

describe('SplitLineView getSourceRange', () => {
    it('identity mapping when no splits (fast path)', () => {
        const view = new SplitLineView(['a', 'b', 'c'], 100);
        assert.deepEqual(view.getSourceRange(0, 3), [0, 3]);
        assert.deepEqual(view.getSourceRange(1, 2), [1, 2]);
    });

    it('maps split virtual lines back to their source line', () => {
        const lines = [
            'short',
            'a long line that will be split into pieces',
            'end',
        ];
        const view = new SplitLineView(lines, 15);

        // First virtual line is source line 0
        const [s0Start, s0End] = view.getSourceRange(0, 1);
        assert.equal(s0Start, 0);
        assert.equal(s0End, 1);

        // All virtual lines from the split long line should map to source line 1
        // Find where source line 1 starts and ends in virtual space
        const [vStart, vEnd] = view.getVirtualRange(1, 2);
        const [srcStart, srcEnd] = view.getSourceRange(vStart, vEnd);
        assert.equal(srcStart, 1);
        assert.equal(srcEnd, 2);
    });

    it('maps range spanning multiple source lines', () => {
        const lines = [
            'a long line that will be split',
            'another long line that splits too',
        ];
        const view = new SplitLineView(lines, 15);
        const [srcStart, srcEnd] = view.getSourceRange(0, view.lineCount);
        assert.equal(srcStart, 0);
        assert.equal(srcEnd, 2);
    });
});

// ── getVirtualRange ─────────────────────────────────────────────────────────

describe('SplitLineView getVirtualRange', () => {
    it('identity mapping when no splits (fast path)', () => {
        const view = new SplitLineView(['a', 'b', 'c'], 100);
        assert.deepEqual(view.getVirtualRange(0, 3), [0, 3]);
        assert.deepEqual(view.getVirtualRange(1, 2), [1, 2]);
    });

    it('expands source line to multiple virtual lines', () => {
        const lines = [
            'short',
            'a long line that will definitely be split into parts',
            'end',
        ];
        const view = new SplitLineView(lines, 15);

        // Source line 1 should map to multiple virtual lines
        const [vStart, vEnd] = view.getVirtualRange(1, 2);
        assert.ok(vEnd - vStart > 1, `Expected multiple virtual lines, got ${vEnd - vStart}`);

        // Source line 0 should map to exactly 1 virtual line
        const [v0Start, v0End] = view.getVirtualRange(0, 1);
        assert.equal(v0End - v0Start, 1);
    });

    it('handles sourceEnd at end of file', () => {
        const lines = [
            'short',
            'a long line that will be split',
        ];
        const view = new SplitLineView(lines, 10);
        const [vStart, vEnd] = view.getVirtualRange(0, 2);
        assert.equal(vStart, 0);
        assert.equal(vEnd, view.lineCount);
    });

    it('handles sourceEnd beyond file length', () => {
        const lines = ['a long line that will be split into parts'];
        const view = new SplitLineView(lines, 10);
        const [vStart, vEnd] = view.getVirtualRange(0, 5);
        assert.equal(vStart, 0);
        assert.equal(vEnd, view.lineCount);
    });

    it('round-trips: getVirtualRange → getSourceRange', () => {
        const lines = [
            'short',
            'a medium length line here',
            'a very long line with many words that will certainly be split into multiple segments',
            'end line',
        ];
        const view = new SplitLineView(lines, 20);

        for (let srcStart = 0; srcStart < lines.length; srcStart++) {
            for (let srcEnd = srcStart + 1; srcEnd <= lines.length; srcEnd++) {
                const [vStart, vEnd] = view.getVirtualRange(srcStart, srcEnd);
                const [rtStart, rtEnd] = view.getSourceRange(vStart, vEnd);
                assert.equal(rtStart, srcStart, `Round-trip failed for [${srcStart}, ${srcEnd})`);
                assert.equal(rtEnd, srcEnd, `Round-trip failed for [${srcStart}, ${srcEnd})`);
            }
        }
    });
});

// ── Edge Cases ──────────────────────────────────────────────────────────────

describe('SplitLineView edge cases', () => {
    it('handles maxLineChars of 1', () => {
        const view = new SplitLineView(['abc'], 1);
        assert.equal(view.lineCount, 3);
        assert.equal(view.getLine(0), 'a');
        assert.equal(view.getLine(1), 'b');
        assert.equal(view.getLine(2), 'c');
        // Reconstruct should match original
        assert.equal(view.getText(0, 3), 'abc');
    });

    it('handles empty string line', () => {
        const view = new SplitLineView(['', 'hello', ''], 100);
        assert.equal(view.lineCount, 3);
        assert.equal(view.getLine(0), '');
        assert.equal(view.getLine(1), 'hello');
        assert.equal(view.getLine(2), '');
    });

    it('handles empty string line with splitting active', () => {
        const lines = ['', 'a long line that triggers splitting', ''];
        const view = new SplitLineView(lines, 10);
        assert.equal(view.lineCount, 6);
        // Empty lines should still be present
        assert.equal(view.getLine(0), '');
        assert.equal(view.getLine(view.lineCount - 1), '');
    });

    it('handles single character lines', () => {
        const lines = ['a', 'b', 'c'];
        const view = new SplitLineView(lines, 1);
        assert.equal(view.lineCount, 3);
        assert.equal(view.getText(0, 3), 'a\nb\nc');
    });

    it('handles very large maxLineChars', () => {
        const lines = ['short', 'also short'];
        const view = new SplitLineView(lines, 1000000);
        assert.equal(view.lineCount, 2);
    });

    it('handles line with trailing space at split point', () => {
        // Space at exactly maxLineChars position
        const line = 'a'.repeat(10) + ' ' + 'b'.repeat(10);
        const view = new SplitLineView([line], 10);
        assert.ok(view.lineCount === 3);
        // Reconstruct should match
        assert.equal(view.getText(0, view.lineCount), line);
    });

    it('handles line with leading spaces', () => {
        const line = '    indented content that is quite long and needs splitting';
        const view = new SplitLineView([line], 20);
        // Reconstruct should preserve leading spaces
        assert.equal(view.getText(0, view.lineCount), line);
    });

    it('full reconstruction matches original for complex input', () => {
        const lines = [
            '// Copyright header',
            '',
            '#include <vector>',
            '',
            'class MyClass {',
            '    void method() {',
            '        // A very long comment that explains something in great detail and goes on and on',
            '        int x = computeSomethingWithAVeryLongFunctionNameThatExceedsTheLimit(arg1, arg2, arg3);',
            '    }',
            '};',
        ];
        const view = new SplitLineView(lines, 40);
        const reconstructed = view.getText(0, view.lineCount);
        assert.equal(reconstructed, lines.join('\n'));
    });
});
