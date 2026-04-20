// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Tests for {@link FileScrubber} from the file scrubber module.
 *
 * Covers:
 *   - validatePatterns (valid maps, invalid regex, invalid glob,
 *     non-string values, combined-regex failure, edge cases)
 *   - scrubFile (single pattern, multiple patterns, multiple matches,
 *     no matches, glob filtering, union of globs, non-capturing group
 *     wrapping, lookbehind, byte-offset preservation, empty map,
 *     empty pattern array)
 *   - updatePatterns (no-op on equal content, update on changed content,
 *     cache invalidation)
 *
 * Run with:
 * npx tsc -p tsconfig.test.json; node --test out-test/tests/common/index/fileScrubber.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { FileScrubber } from '../../../src/common/index/fileScrubber';
import type { FileScrubPatterns } from '../../../src/common/index/fileScrubber';

// ── validatePatterns ────────────────────────────────────────────────

describe('FileScrubber.validatePatterns', () => {

    it('returns null for undefined input', () => {
        assert.equal(FileScrubber.validatePatterns(undefined), null);
    });

    it('returns null for an empty map', () => {
        assert.equal(FileScrubber.validatePatterns({}), null);
    });

    it('returns null for a valid map with one glob and one pattern', () => {
        const map: FileScrubPatterns = { '**/*.h': ['\\bBASE_EXPORT\\b'] };
        assert.equal(FileScrubber.validatePatterns(map), null);
    });

    it('returns null for a valid map with multiple globs and patterns', () => {
        const map: FileScrubPatterns = {
            '**/*.h': ['\\bBASE_EXPORT\\b', '\\bCONTENT_EXPORT\\b'],
            '**/*.cc': ['\\bMEDIA_MOJO_EXPORT\\b'],
        };
        assert.equal(FileScrubber.validatePatterns(map), null);
    });

    it('returns null for a glob with an empty pattern array', () => {
        const map: FileScrubPatterns = { '**/*.h': [] };
        assert.equal(FileScrubber.validatePatterns(map), null);
    });

    it('returns null for patterns with lookbehind', () => {
        const map: FileScrubPatterns = {
            '**/*.h': ['(?<=\\bclass\\s+)MEDIA_MOJO_EXPORT\\b'],
        };
        assert.equal(FileScrubber.validatePatterns(map), null);
    });

    it('returns error for invalid regex pattern', () => {
        const map: FileScrubPatterns = { '**/*.h': ['[invalid'] };
        const result = FileScrubber.validatePatterns(map);
        assert.notEqual(result, null);
        assert.ok(result!.includes('[invalid'));
        assert.ok(result!.includes('**/*.h'));
    });

    it('returns error for non-string pattern', () => {
        const map = { '**/*.h': [123 as unknown as string] };
        const result = FileScrubber.validatePatterns(map);
        assert.notEqual(result, null);
        assert.ok(result!.includes('not a string'));
    });

    it('returns error for non-array value', () => {
        const map = { '**/*.h': 'not-an-array' as unknown as string[] };
        const result = FileScrubber.validatePatterns(map);
        assert.notEqual(result, null);
        assert.ok(result!.includes('must be an array'));
    });

    it('detects first invalid pattern among multiple', () => {
        const map: FileScrubPatterns = {
            '**/*.h': ['\\bOK\\b', '[bad', '\\bALSO_OK\\b'],
        };
        const result = FileScrubber.validatePatterns(map);
        assert.notEqual(result, null);
        assert.ok(result!.includes('[bad'));
    });

    it('validates combined regex form', () => {
        // Individual patterns are valid but combining them might
        // theoretically fail. Hard to construct in practice, but
        // the code path exists and should be exercised.
        // Use individually valid patterns that combine cleanly.
        const map: FileScrubPatterns = {
            '**/*.h': ['a|b', 'c|d'],
        };
        assert.equal(FileScrubber.validatePatterns(map), null);
    });
});

// ── scrubFile ───────────────────────────────────────────────────────────────

describe('FileScrubber.scrubFile', () => {

    // ── Basic scrubbing ─────────────────────────────────────────────────

    it('replaces a single macro match with spaces of equal length', () => {
        const scrubber = new FileScrubber({
            '**/*.h': ['\\bBASE_EXPORT\\b'],
        });
        const source = 'class BASE_EXPORT Foo {';
        const result = scrubber.scrubFile(source, 'd:/src/foo.h');
        assert.notEqual(result, null);
        assert.equal(result, 'class             Foo {');
        assert.equal(result!.length, source.length);
    });

    it('replaces multiple matches in the same source', () => {
        const scrubber = new FileScrubber({
            '**/*.h': ['\\bEXPORT\\b'],
        });
        const source = 'EXPORT void foo(); EXPORT int bar();';
        const result = scrubber.scrubFile(source, 'd:/src/test.h');
        assert.notEqual(result, null);
        assert.equal(result, '       void foo();        int bar();');
        assert.equal(result!.length, source.length);
    });

    it('replaces matches from multiple patterns under one glob', () => {
        const scrubber = new FileScrubber({
            '**/*.h': ['\\bBASE_EXPORT\\b', '\\bNET_EXPORT\\b'],
        });
        const source = 'class BASE_EXPORT Foo {}; class NET_EXPORT Bar {};';
        const result = scrubber.scrubFile(source, 'd:/src/foo.h');
        assert.notEqual(result, null);
        assert.ok(!result!.includes('BASE_EXPORT'));
        assert.ok(!result!.includes('NET_EXPORT'));
        assert.equal(result!.length, source.length);
        assert.equal(result, 'class             Foo {}; class            Bar {};');
    });

    // ── Glob matching ───────────────────────────────────────────────────

    it('returns null when no glob matches the file path', () => {
        const scrubber = new FileScrubber({
            '**/*.cc': ['\\bBASE_EXPORT\\b'],
        });
        const source = 'class BASE_EXPORT Foo {';
        const result = scrubber.scrubFile(source, 'd:/src/foo.h');
        assert.equal(result, null);
    });

    it('applies patterns from all matching globs (union)', () => {
        const scrubber = new FileScrubber({
            '**/*.h': ['\\bBASE_EXPORT\\b'],
            '**/media/**': ['\\bMEDIA_EXPORT\\b'],
        });
        const source = 'BASE_EXPORT void foo(); MEDIA_EXPORT void bar();';
        // File matches both globs
        const result = scrubber.scrubFile(source, 'd:/src/media/foo.h');
        assert.notEqual(result, null);
        assert.ok(!result!.includes('BASE_EXPORT'));
        assert.ok(!result!.includes('MEDIA_EXPORT'));
        assert.equal(result, '            void foo();              void bar();');
        assert.equal(result!.length, source.length);
    });

    it('only applies patterns from matching globs, not all globs', () => {
        const scrubber = new FileScrubber({
            '**/*.h': ['\\bBASE_EXPORT\\b'],
            '**/media/**': ['\\bMEDIA_EXPORT\\b'],
        });
        const source = 'BASE_EXPORT void foo(); MEDIA_EXPORT void bar();';
        // File matches only the *.h glob, not the media glob
        const result = scrubber.scrubFile(source, 'd:/src/chrome/foo.h');
        assert.notEqual(result, null);
        assert.ok(!result!.includes('BASE_EXPORT'));
        assert.ok(result!.includes('MEDIA_EXPORT')); // Not scrubbed
        assert.equal(result!.length, source.length);
    });

    it('brace-expansion glob matches multiple file extensions', () => {
        const scrubber = new FileScrubber({
            '**/*.{h,cc,cpp}': ['\\bEXPORT\\b'],
        });
        const source = 'EXPORT void foo();';
        const expected = '       void foo();';

        // .h matches
        assert.equal(scrubber.scrubFile(source, 'd:/src/foo.h'), expected);
        // .cc matches
        assert.equal(scrubber.scrubFile(source, 'd:/src/foo.cc'), expected);
        // .cpp matches
        assert.equal(scrubber.scrubFile(source, 'd:/src/foo.cpp'), expected);
        // .c does NOT match
        assert.equal(scrubber.scrubFile(source, 'd:/src/foo.c'), null);
        // .hpp does NOT match
        assert.equal(scrubber.scrubFile(source, 'd:/src/foo.hpp'), null);
        // .md does NOT match
        assert.equal(scrubber.scrubFile(source, 'd:/src/foo.md'), null);
    });

    // ── Byte-offset preservation ────────────────────────────────────────

    it('preserves byte offsets — every character position is stable', () => {
        const scrubber = new FileScrubber({
            '**/*.h': ['\\bMEDIA_MOJO_EXPORT\\b'],
        });
        const source = 'class MEDIA_MOJO_EXPORT MediaFoundationService final {';
        const result = scrubber.scrubFile(source, 'd:/src/media/service.h');

        // Length preserved
        assert.equal(result!.length, source.length);

        // Characters before the macro are untouched
        assert.equal(result!.substring(0, 6), 'class ');

        // Characters after the macro are untouched at the same positions
        const macroEnd = source.indexOf('MEDIA_MOJO_EXPORT') + 'MEDIA_MOJO_EXPORT'.length;
        assert.equal(result!.substring(macroEnd), source.substring(macroEnd));
    });

    // ── Non-capturing group wrapping ────────────────────────────────────

    it('wraps patterns in non-capturing groups to prevent alternation bleed', () => {
        const scrubber = new FileScrubber({
            '**/*.h': ['a|b', 'c|d'],
        });
        const source = 'a b c d e';
        const result = scrubber.scrubFile(source, 'd:/src/foo.h');
        // a, b, c, d should all be replaced; e should not
        assert.equal(result, '        e');
    });

    it('handles pattern with internal non-capturing group', () => {
        const scrubber = new FileScrubber({
            '**/*.h': ['a(?:b|c)d'],
        });
        const source = 'abd acd aed';
        const result = scrubber.scrubFile(source, 'd:/src/foo.h');
        // abd and acd replaced with 3 spaces each; aed untouched
        assert.equal(result, '        aed');
        assert.equal(result!.length, source.length);
    });

    // ── Lookbehind ──────────────────────────────────────────────────────

    it('supports lookbehind — only the match is replaced, not the lookbehind', () => {
        const scrubber = new FileScrubber({
            '**/*.h': ['(?<=\\bclass\\s+)MEDIA_MOJO_EXPORT\\b'],
        });
        const source = 'class MEDIA_MOJO_EXPORT MediaFoundationService';
        const result = scrubber.scrubFile(source, 'd:/src/foo.h');
        // 'class ' is preserved, macro is blanked
        assert.ok(result!.startsWith('class '));
        assert.ok(!result!.includes('MEDIA_MOJO_EXPORT'));
        assert.ok(result!.includes('MediaFoundationService'));
        assert.equal(result, 'class                   MediaFoundationService');
        assert.equal(result!.length, source.length);
    });

    it('lookbehind does not match when context is absent', () => {
        const scrubber = new FileScrubber({
            '**/*.h': ['(?<=\\bclass\\s+)MEDIA_MOJO_EXPORT\\b'],
        });
        const source = 'void MEDIA_MOJO_EXPORT foo();';
        const result = scrubber.scrubFile(source, 'd:/src/foo.h');
        // Not preceded by 'class ', so no replacement
        assert.equal(result, null);
    });

    it('combines multiple lookbehind patterns under one glob', () => {
        const scrubber = new FileScrubber({
            '**/*.h': [
                '(?<=\\bclass\\s+)MEDIA_MOJO_EXPORT\\b',
                '(?<=\\bstruct\\s+)BASE_EXPORT\\b',
            ],
        });
        const source = [
            'class MEDIA_MOJO_EXPORT MediaService {',
            'struct BASE_EXPORT Config {',
            'void MEDIA_MOJO_EXPORT standalone();',
            'int BASE_EXPORT other();',
        ].join('\n');
        const result = scrubber.scrubFile(source, 'd:/src/foo.h');

        // class context → MEDIA_MOJO_EXPORT scrubbed
        assert.ok(result!.includes('class '));
        assert.ok(result!.includes('MediaService'));
        // struct context → BASE_EXPORT scrubbed
        assert.ok(result!.includes('struct '));
        assert.ok(result!.includes('Config'));
        // Wrong context → not scrubbed
        assert.ok(result!.includes('void MEDIA_MOJO_EXPORT'));
        assert.ok(result!.includes('int BASE_EXPORT'));
        assert.equal(result!.length, source.length);

        const lines = result!.split('\n');
        assert.equal(lines[0], 'class                   MediaService {');
        assert.equal(lines[1], 'struct             Config {');
        assert.equal(lines[2], 'void MEDIA_MOJO_EXPORT standalone();');
        assert.equal(lines[3], 'int BASE_EXPORT other();');
    });

    // ── Newline anchoring via lookahead / lookbehind ─────────────────────

    it('lookbehind with \\n matches macro only at the start of a line', () => {
        const scrubber = new FileScrubber({
            '**/*.h': ['(?<=\\n)EXPORT\\b'],
        });
        const source = 'EXPORT first\nEXPORT second\nmid EXPORT third';
        const result = scrubber.scrubFile(source, 'd:/src/foo.h');
        const lines = result!.split('\n');
        // First line: no preceding \n, so EXPORT is NOT scrubbed
        assert.equal(lines[0], 'EXPORT first');
        // Second line: preceded by \n, EXPORT IS scrubbed
        assert.equal(lines[1], '       second');
        // Third line: EXPORT is mid-line (preceded by space, not \n), NOT scrubbed
        assert.equal(lines[2], 'mid EXPORT third');
        assert.equal(result!.length, source.length);
    });

    it('lookbehind with ^|\\n matches macro at start of string or start of line', () => {
        const scrubber = new FileScrubber({
            '**/*.h': ['(?<=^|\\n)EXPORT\\b'],
        });
        const source = 'EXPORT first\nEXPORT second\nmid EXPORT third';
        const result = scrubber.scrubFile(source, 'd:/src/foo.h');
        const lines = result!.split('\n');
        // First line: start of string, EXPORT IS scrubbed
        assert.equal(lines[0], '       first');
        // Second line: start of line, EXPORT IS scrubbed
        assert.equal(lines[1], '       second');
        // Third line: mid-line, NOT scrubbed
        assert.equal(lines[2], 'mid EXPORT third');
        assert.equal(result!.length, source.length);
    });

    it('lookahead with \\n matches macro only at the end of a line', () => {
        const scrubber = new FileScrubber({
            '**/*.h': ['\\bEXPORT(?=\\n)'],
        });
        const source = 'first EXPORT\nEXPORT second\nthird EXPORT';
        const result = scrubber.scrubFile(source, 'd:/src/foo.h');
        const lines = result!.split('\n');
        // First line: EXPORT followed by \n, IS scrubbed
        assert.equal(lines[0], 'first       ');
        // Second line: EXPORT followed by space, NOT scrubbed
        assert.equal(lines[1], 'EXPORT second');
        // Third line: EXPORT at end of string (no \n), NOT scrubbed
        assert.equal(lines[2], 'third EXPORT');
        assert.equal(result!.length, source.length);
    });

    it('lookahead with \\n|$ matches macro at end of line or end of string', () => {
        const scrubber = new FileScrubber({
            '**/*.h': ['\\bEXPORT(?=\\n|$)'],
        });
        const source = 'first EXPORT\nEXPORT second\nthird EXPORT';
        const result = scrubber.scrubFile(source, 'd:/src/foo.h');
        const lines = result!.split('\n');
        // First line: EXPORT followed by \n, IS scrubbed
        assert.equal(lines[0], 'first       ');
        // Second line: EXPORT followed by space, NOT scrubbed
        assert.equal(lines[1], 'EXPORT second');
        // Third line: EXPORT at end of string, IS scrubbed
        assert.equal(lines[2], 'third       ');
        assert.equal(result!.length, source.length);
    });

    it('uses lookaround to assert surrounding whitespace without consuming it', () => {
        // Match MACRO only when surrounded by whitespace, but the
        // whitespace is in zero-width assertions so only the macro
        // name itself is replaced — surrounding spaces stay intact.
        const scrubber = new FileScrubber({
            '**/*.h': ['(?<=\\s)MACRO(?=\\s)'],
        });
        const source = 'class MACRO Foo;\nno_space_MACRO_here;\n  MACRO  end';
        const result = scrubber.scrubFile(source, 'd:/src/foo.h');
        const lines = result!.split('\n');
        // 'class MACRO Foo;' → MACRO has \s before and after, scrubbed
        assert.equal(lines[0], 'class       Foo;');
        // 'no_space_MACRO_here;' → MACRO not surrounded by \s, NOT scrubbed
        assert.equal(lines[1], 'no_space_MACRO_here;');
        // '  MACRO  end' → MACRO has \s before and after, scrubbed
        // original: '  MACRO  end' (2 + 5 + 2 + 3 = 12 chars)
        // result:   '         end' (2 + 5 + 2 + 3 = 12 chars, MACRO → 5 spaces)
        assert.equal(lines[2], '         end');
        assert.equal(result!.length, source.length);
    });

    // ── Edge cases ──────────────────────────────────────────────────────

    it('returns null for empty FileScrubPatterns map', () => {
        const scrubber = new FileScrubber({});
        const source = 'class BASE_EXPORT Foo {';
        const result = scrubber.scrubFile(source, 'd:/src/foo.h');
        assert.equal(result, null);
    });

    it('returns null when glob matches but pattern array is empty', () => {
        const scrubber = new FileScrubber({ '**/*.h': [] });
        const source = 'class BASE_EXPORT Foo {';
        const result = scrubber.scrubFile(source, 'd:/src/foo.h');
        assert.equal(result, null);
    });

    it('returns null when pattern does not match any text', () => {
        const scrubber = new FileScrubber({
            '**/*.h': ['\\bNONEXISTENT_MACRO\\b'],
        });
        const source = 'class Foo {};';
        const result = scrubber.scrubFile(source, 'd:/src/foo.h');
        assert.equal(result, null);
    });

    it('returns null for empty source string', () => {
        const scrubber = new FileScrubber({
            '**/*.h': ['\\bFOO\\b'],
        });
        const result = scrubber.scrubFile('', 'd:/src/foo.h');
        assert.equal(result, null);
    });

    it('handles Windows-style absolute paths', () => {
        const scrubber = new FileScrubber({
            'd:/cs/src/**/*.h': ['\\bBASE_EXPORT\\b'],
        });
        const source = 'BASE_EXPORT void foo();';
        const result = scrubber.scrubFile(source, 'd:/cs/src/base/foo.h');
        assert.ok(!result!.includes('BASE_EXPORT'));
        assert.equal(result!.length, source.length);
    });

    it('handles backslash Windows paths', () => {
        const scrubber = new FileScrubber({
            'd:/cs/src/**/*.h': ['\\bBASE_EXPORT\\b'],
        });
        const source = 'BASE_EXPORT void foo();';
        const result = scrubber.scrubFile(source, 'd:\\cs\\src\\base\\foo.h');
        assert.ok(!result!.includes('BASE_EXPORT'));
        assert.equal(result!.length, source.length);
    });

    it('does not replace partial identifier matches without word boundary', () => {
        const scrubber = new FileScrubber({
            '**/*.h': ['\\bBASE_EXPORT\\b'],
        });
        const source = 'MY_BASE_EXPORTER is not BASE_EXPORT';
        const result = scrubber.scrubFile(source, 'd:/src/foo.h');
        // Only standalone BASE_EXPORT replaced, not MY_BASE_EXPORTER
        assert.ok(result!.includes('MY_BASE_EXPORTER'));
        assert.ok(!result!.endsWith('BASE_EXPORT'));
        assert.equal(result, 'MY_BASE_EXPORTER is not            ');
    });

    it('handles multiline source', () => {
        const scrubber = new FileScrubber({
            '**/*.h': ['\\bEXPORT\\b'],
        });
        const source = 'line1 EXPORT foo\nline2 EXPORT bar\nline3 plain';
        const result = scrubber.scrubFile(source, 'd:/src/foo.h');
        const lines = result!.split('\n');
        assert.equal(lines.length, 3);
        assert.ok(!lines[0].includes('EXPORT'));
        assert.ok(!lines[1].includes('EXPORT'));
        assert.ok(lines[2].includes('plain'));
        assert.equal(result!.length, source.length);
    });

    it('handles the Chromium wildcard export pattern', () => {
        const scrubber = new FileScrubber({
            '**/*.{h,cc,cpp}': ['\\b[A-Z][A-Z0-9_]*_EXPORT(?:_PRIVATE)?\\b'],
        });
        const source = [
            'class BASE_EXPORT Foo {};',
            'class CONTENT_EXPORT_PRIVATE Bar {};',
            'class MEDIA_MOJO_EXPORT Baz {};',
            'class NormalClass {};',
        ].join('\n');
        const result = scrubber.scrubFile(source, 'd:/cs/src/foo.h');
        assert.notEqual(result, null);
        assert.ok(!result!.includes('BASE_EXPORT'));
        assert.ok(!result!.includes('CONTENT_EXPORT_PRIVATE'));
        assert.ok(!result!.includes('MEDIA_MOJO_EXPORT'));
        assert.ok(result!.includes('class NormalClass {}'));
        assert.equal(result!.length, source.length);
    });
});

// ── updatePatterns ──────────────────────────────────────────────────────────

describe('FileScrubber.updatePatterns', () => {

    it('returns false when the new map is identical in content', () => {
        const map1: FileScrubPatterns = { '**/*.h': ['\\bFOO\\b', '\\bBAR\\b'] };
        const map2: FileScrubPatterns = { '**/*.h': ['\\bFOO\\b', '\\bBAR\\b'] };
        const scrubber = new FileScrubber(map1);
        assert.equal(scrubber.updatePatterns(map2), false);
    });

    it('returns true when patterns differ', () => {
        const map1: FileScrubPatterns = { '**/*.h': ['\\bFOO\\b'] };
        const map2: FileScrubPatterns = { '**/*.h': ['\\bBAR\\b'] };
        const scrubber = new FileScrubber(map1);
        assert.equal(scrubber.updatePatterns(map2), true);
    });

    it('returns true when a glob is added', () => {
        const map1: FileScrubPatterns = { '**/*.h': ['\\bFOO\\b'] };
        const map2: FileScrubPatterns = { '**/*.h': ['\\bFOO\\b'], '**/*.cc': ['\\bBAR\\b'] };
        const scrubber = new FileScrubber(map1);
        assert.equal(scrubber.updatePatterns(map2), true);
    });

    it('returns true when a glob is removed', () => {
        const map1: FileScrubPatterns = { '**/*.h': ['\\bFOO\\b'], '**/*.cc': ['\\bBAR\\b'] };
        const map2: FileScrubPatterns = { '**/*.h': ['\\bFOO\\b'] };
        const scrubber = new FileScrubber(map1);
        assert.equal(scrubber.updatePatterns(map2), true);
    });

    it('returns true when pattern order changes', () => {
        const map1: FileScrubPatterns = { '**/*.h': ['\\bFOO\\b', '\\bBAR\\b'] };
        const map2: FileScrubPatterns = { '**/*.h': ['\\bBAR\\b', '\\bFOO\\b'] };
        const scrubber = new FileScrubber(map1);
        assert.equal(scrubber.updatePatterns(map2), true);
    });

    it('returns false for both empty maps', () => {
        const scrubber = new FileScrubber({});
        assert.equal(scrubber.updatePatterns({}), false);
    });

    it('returns true transitioning from empty to non-empty', () => {
        const scrubber = new FileScrubber({});
        assert.equal(scrubber.updatePatterns({ '**/*.h': ['\\bFOO\\b'] }), true);
    });

    it('returns true transitioning from non-empty to empty', () => {
        const scrubber = new FileScrubber({ '**/*.h': ['\\bFOO\\b'] });
        assert.equal(scrubber.updatePatterns({}), true);
    });

    it('uses new patterns after update', () => {
        const scrubber = new FileScrubber({
            '**/*.h': ['\\bOLD_MACRO\\b'],
        });
        const source = 'OLD_MACRO NEW_MACRO';

        // Before update: only OLD_MACRO is scrubbed
        let result = scrubber.scrubFile(source, 'd:/src/foo.h');
        assert.notEqual(result, null);
        assert.ok(!result!.includes('OLD_MACRO'));
        assert.ok(result!.includes('NEW_MACRO'));

        // Update to target NEW_MACRO instead
        scrubber.updatePatterns({ '**/*.h': ['\\bNEW_MACRO\\b'] });

        // After update: only NEW_MACRO is scrubbed
        result = scrubber.scrubFile(source, 'd:/src/foo.h');
        assert.notEqual(result, null);
        assert.ok(result!.includes('OLD_MACRO'));
        assert.ok(!result!.includes('NEW_MACRO'));
        assert.equal(result!.length, source.length);
    });

    it('clears regex cache on update so stale patterns are not used', () => {
        const scrubber = new FileScrubber({
            '**/*.h': ['\\bFIRST\\b'],
        });
        const source = 'FIRST SECOND';

        // Populate the cache
        scrubber.scrubFile(source, 'd:/src/foo.h');

        // Update with different patterns under the same glob key
        scrubber.updatePatterns({ '**/*.h': ['\\bSECOND\\b'] });

        const result = scrubber.scrubFile(source, 'd:/src/foo.h');
        assert.notEqual(result, null);
        // FIRST should NOT be scrubbed (old pattern gone)
        // SECOND should be scrubbed (new pattern active)
        assert.ok(result!.includes('FIRST'));
        assert.ok(!result!.includes('SECOND'));
        assert.equal(result, 'FIRST       ');
    });
});
