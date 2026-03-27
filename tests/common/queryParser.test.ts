// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Tests for {@link parseQueryAsAndOr} from the query parser.
 *
 * Covers:
 *   - Plain terms (single and multiple, AND semantics)
 *   - Glob wildcards (* and ?)
 *   - OR groups with (A|B) syntax
 *   - Multiple OR groups in one query
 *   - Literal parentheses (no pipe inside)
 *   - Mixed OR groups and plain terms
 *   - Edge cases (empty query, unclosed parens, empty alternatives)
 *   - Regex special character escaping
 *   - Glob wildcards inside OR groups
 *
 * Run with:
 * npx tsc -p tsconfig.test.json; node --test out-test/tests/common/queryParser.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseQueryAsAndOr } from '../../src/common/queryParser';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Assert that a regex pattern matches a given string.
 */
function assertMatches(pattern: string, text: string, message?: string) {
    const re = new RegExp(pattern);
    assert.ok(re.test(text), message ?? `Expected /${pattern}/ to match "${text}"`);
}

/**
 * Assert that a regex pattern does NOT match a given string.
 */
function assertNoMatch(pattern: string, text: string, message?: string) {
    const re = new RegExp(pattern);
    assert.ok(!re.test(text), message ?? `Expected /${pattern}/ NOT to match "${text}"`);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('parseQueryAsAndOr', () => {

    // ── Empty / whitespace ──────────────────────────────────────────────

    describe('empty and whitespace inputs', () => {
        it('returns empty array for empty string', () => {
            assert.deepStrictEqual(parseQueryAsAndOr(''), []);
        });

        it('returns empty array for whitespace-only string', () => {
            assert.deepStrictEqual(parseQueryAsAndOr('   '), []);
        });

        it('returns empty array for tab-only string', () => {
            assert.deepStrictEqual(parseQueryAsAndOr('\t\t'), []);
        });
    });

    // ── Plain terms (AND semantics) ─────────────────────────────────────

    describe('plain terms', () => {
        it('single term produces one pattern', () => {
            const result = parseQueryAsAndOr('foo');
            assert.strictEqual(result.length, 1);
            assertMatches(result[0], 'foo');
            assertNoMatch(result[0], 'bar');
        });

        it('two space-separated terms produce two patterns (AND)', () => {
            const result = parseQueryAsAndOr('foo bar');
            assert.strictEqual(result.length, 2);
            assertMatches(result[0], 'foo');
            assertMatches(result[1], 'bar');
        });

        it('three terms produce three patterns', () => {
            const result = parseQueryAsAndOr('alpha beta gamma');
            assert.strictEqual(result.length, 3);
            assertMatches(result[0], 'alpha');
            assertMatches(result[1], 'beta');
            assertMatches(result[2], 'gamma');
            assertNoMatch(result[2], 'bar');
        });

        it('extra whitespace between terms is ignored', () => {
            const result = parseQueryAsAndOr('  foo   bar  ');
            assert.strictEqual(result.length, 2);
            assertMatches(result[0], 'foo');
            assertMatches(result[1], 'bar');
        });
    });

    // ── Glob wildcards ──────────────────────────────────────────────────

    describe('glob wildcards', () => {
        it('* matches zero or more characters within a line', () => {
            const result = parseQueryAsAndOr('Get*Configs');
            assert.strictEqual(result.length, 1);
            assertMatches(result[0], 'GetSupportedConfigs');
            assertMatches(result[0], 'GetConfigs');
            assertMatches(result[0], 'GetVideoDecoderConfigs');
            assertNoMatch(result[0], 'SetConfigs');
        });

        it('* does not match across newlines', () => {
            const result = parseQueryAsAndOr('foo*bar');
            assert.strictEqual(result.length, 1);
            assertNoMatch(result[0], 'foo\nbar');
            assertMatches(result[0], 'foobar');
        });

        it('? matches exactly one character', () => {
            const result = parseQueryAsAndOr('D3D1?');
            assert.strictEqual(result.length, 1);
            assertMatches(result[0], 'D3D11');
            assertMatches(result[0], 'D3D12');
            assertNoMatch(result[0], 'D3D1');   // ? requires one char
            // Note: D3D1? as a regex (D3D1.) will match within "D3D100"
            // because the pattern is not anchored. This is expected —
            // search is substring-based, not whole-word.
        });

        it('combined * and ? in one term', () => {
            const result = parseQueryAsAndOr('D3D1?Video*');
            assert.strictEqual(result.length, 1);
            assertMatches(result[0], 'D3D11VideoDecoder');
            assertMatches(result[0], 'D3D12Video');
            assertNoMatch(result[0], 'D3D1VideoDecoder'); // ? not satisfied
        });

        it('multiple terms with wildcards', () => {
            const result = parseQueryAsAndOr('Get*Configs D3D1?');
            assert.strictEqual(result.length, 2);
            assertMatches(result[0], 'GetSupportedDecoderConfigs');
            assertMatches(result[1], 'D3D11');
        });

        it('parentheses within a term are treated as literal', () => {
            const result = parseQueryAsAndOr('void*test(int*)');
            assert.strictEqual(result.length, 1);
            assertMatches(result[0], 'void foo_test(int* ptr)');
            assertMatches(result[0], 'void_test(int_x)');
            assertNoMatch(result[0], 'int*test(void*)');
        });
    });

    // ── OR groups ───────────────────────────────────────────────────────

    describe('OR groups', () => {
        it('basic two-alternative OR group', () => {
            const result = parseQueryAsAndOr('(video_codec|audio_codec)');
            assert.strictEqual(result.length, 1);
            assertMatches(result[0], 'video_codec');
            assertMatches(result[0], 'audio_codec');
            assertNoMatch(result[0], 'subtitle_codec');
        });

        it('three-alternative OR group', () => {
            const result = parseQueryAsAndOr('(alpha|beta|gamma)');
            assert.strictEqual(result.length, 1);
            assertMatches(result[0], 'alpha');
            assertMatches(result[0], 'beta');
            assertMatches(result[0], 'gamma');
            assertNoMatch(result[0], 'delta');
        });

        it('OR group with AND term', () => {
            const result = parseQueryAsAndOr('(video_codec|audio_codec) MediaLogProperty');
            assert.strictEqual(result.length, 2);
            // First pattern is the OR group
            assertMatches(result[0], 'video_codec');
            assertMatches(result[0], 'audio_codec');
            // Second pattern is the plain term
            assertMatches(result[1], 'MediaLogProperty');
        });

        it('OR group after AND term', () => {
            const result = parseQueryAsAndOr('MediaLogProperty (video_codec|audio_codec)');
            assert.strictEqual(result.length, 2);
            assertMatches(result[0], 'MediaLogProperty');
            assertMatches(result[1], 'video_codec');
            assertMatches(result[1], 'audio_codec');
        });

        it('multiple OR groups', () => {
            const result = parseQueryAsAndOr('(A|B) (C|D)');
            assert.strictEqual(result.length, 2);
            assertMatches(result[0], 'A');
            assertMatches(result[0], 'B');
            assertNoMatch(result[0], 'C');
            assertMatches(result[1], 'C');
            assertMatches(result[1], 'D');
            assertNoMatch(result[1], 'A');
        });

        it('OR group with glob wildcards in alternatives', () => {
            const result = parseQueryAsAndOr('(HEVCPROFILE_*|AV1PROFILE_*)');
            assert.strictEqual(result.length, 1);
            assertMatches(result[0], 'HEVCPROFILE_MAIN');
            assertMatches(result[0], 'HEVCPROFILE_MAIN10');
            assertMatches(result[0], 'AV1PROFILE_MAIN');
            assertNoMatch(result[0], 'VP9PROFILE_0');
        });

        it('OR group with wildcards plus AND term with wildcard', () => {
            const result = parseQueryAsAndOr('(HEVCPROFILE_*|AV1PROFILE_*) GetSupported*Configs');
            assert.strictEqual(result.length, 2);
            assertMatches(result[0], 'HEVCPROFILE_MAIN');
            assertMatches(result[0], 'AV1PROFILE_MAIN');
            assertMatches(result[1], 'GetSupportedDecoderConfigs');
        });

        it('OR group with ? wildcard in alternatives', () => {
            const result = parseQueryAsAndOr('(D3D1?|Vulkan)');
            assert.strictEqual(result.length, 1);
            assertMatches(result[0], 'D3D11');
            assertMatches(result[0], 'D3D12');
            assertMatches(result[0], 'Vulkan');
            assertNoMatch(result[0], 'D3D1');
        });

        it('whitespace around alternatives is trimmed', () => {
            const result = parseQueryAsAndOr('( video_codec | audio_codec )');
            assert.strictEqual(result.length, 1);
            assertMatches(result[0], 'video_codec');
            assertMatches(result[0], 'audio_codec');
        });
    });

    // ── Literal parentheses (no pipe) ───────────────────────────────────

    describe('literal parentheses', () => {
        it('parenthesized content without pipe is treated as literal', () => {
            const result = parseQueryAsAndOr('(void) callback');
            assert.strictEqual(result.length, 2);
            assertMatches(result[0], '(void)');
            assertMatches(result[1], 'callback');
        });

        it('single parenthesized term without pipe is literal', () => {
            const result = parseQueryAsAndOr('(int)');
            assert.strictEqual(result.length, 1);
            assertMatches(result[0], '(int)');
            assertNoMatch(result[0], 'int'); // must include parens
        });

        it('parenthesized expression without pipe is literal', () => {
            // "(" starts a group, content is "x + y" which has no pipe
            // so treated as literal "(x + y)"
            const result = parseQueryAsAndOr('(x+y)');
            assert.strictEqual(result.length, 1);
            assertMatches(result[0], '(x+y)');
        });
    });

    // ── Regex special character escaping ─────────────────────────────────

    describe('regex special character escaping', () => {
        it('dots are escaped', () => {
            const result = parseQueryAsAndOr('foo.bar');
            assert.strictEqual(result.length, 1);
            assertMatches(result[0], 'foo.bar');
            assertNoMatch(result[0], 'fooXbar'); // dot must be literal
        });

        it('plus signs are escaped', () => {
            const result = parseQueryAsAndOr('c++');
            assert.strictEqual(result.length, 1);
            assertMatches(result[0], 'c++');
        });

        it('brackets are escaped', () => {
            const result = parseQueryAsAndOr('array[0]');
            assert.strictEqual(result.length, 1);
            assertMatches(result[0], 'array[0]');
        });

        it('caret and dollar are escaped', () => {
            const result = parseQueryAsAndOr('$value ^start');
            assert.strictEqual(result.length, 2);
            assertMatches(result[0], '$value');
            assertMatches(result[1], '^start');
        });

        it('backslash is escaped', () => {
            const result = parseQueryAsAndOr('path\\to');
            assert.strictEqual(result.length, 1);
            assertMatches(result[0], 'path\\to');
        });

        it('special chars inside OR group alternatives are escaped', () => {
            const result = parseQueryAsAndOr('(foo.bar|baz+qux)');
            assert.strictEqual(result.length, 1);
            assertMatches(result[0], 'foo.bar');
            assertMatches(result[0], 'baz+qux');
            assertNoMatch(result[0], 'fooXbar');
        });
    });

    // ── Edge cases ──────────────────────────────────────────────────────

    describe('edge cases', () => {
        it('unclosed parenthesis is treated as a plain term', () => {
            const result = parseQueryAsAndOr('(unclosed');
            assert.strictEqual(result.length, 1);
            // The entire "(unclosed" is a plain term
            assertMatches(result[0], '(unclosed');
        });

        it('unclosed paren followed by other terms treats rest as one term', () => {
            const result = parseQueryAsAndOr('(unclosed foo');
            // No closing paren found — everything from ( to end is one term
            assert.strictEqual(result.length, 1);
        });

        it('empty OR group is ignored', () => {
            const result = parseQueryAsAndOr('(|) foo');
            // "|" splits into empty strings which get filtered out
            // The empty OR group produces nothing, "foo" is a plain term
            assert.strictEqual(result.length, 1);
            assertMatches(result[0], 'foo');
        });

        it('OR group with empty alternatives filters them out', () => {
            const result = parseQueryAsAndOr('(A||B)');
            assert.strictEqual(result.length, 1);
            assertMatches(result[0], 'A');
            assertMatches(result[0], 'B');
        });

        it('adjacent OR groups without space', () => {
            const result = parseQueryAsAndOr('(A|B)(C|D)');
            // First ( is at token boundary — parsed as OR group
            // Second ( is also at token boundary after ) — parsed as OR group
            assert.strictEqual(result.length, 2);
            assertMatches(result[0], 'A');
            assertMatches(result[0], 'B');
            assertNoMatch(result[0], 'C');
            assertMatches(result[1], 'C');
            assertMatches(result[1], 'D');
            assertNoMatch(result[1], 'A');
        });

        it('term immediately before OR group without space is a plain term', () => {
            const result = parseQueryAsAndOr('prefix(A|B)');
            // No space separator — entire string is one plain term
            assert.strictEqual(result.length, 1);
            assertMatches(result[0], 'prefix(A|B)');
        });

        it('term immediately after OR group without space', () => {
            const result = parseQueryAsAndOr('(A|B)suffix');
            // ( is at token boundary — parsed as OR group, then suffix is a new term
            assert.strictEqual(result.length, 2);
            assertMatches(result[0], 'A');
            assertMatches(result[0], 'B');
            assertMatches(result[1], 'suffix');
        });

        it('single alternative in parens with pipe is still an OR group', () => {
            // "(A|)" has pipe so it's an OR group — empty alternative filtered
            const result = parseQueryAsAndOr('(A|)');
            assert.strictEqual(result.length, 1);
            assertMatches(result[0], 'A');
        });
    });

    // ── Real-world examples ─────────────────────────

    describe('real-world examples', () => {
        it('codec name OR with MediaLogProperty AND', () => {
            const result = parseQueryAsAndOr('(video_codec_name|audio_codec_name) MediaLogProperty');
            assert.strictEqual(result.length, 2);
            assertMatches(result[0], 'video_codec_name');
            assertMatches(result[0], 'audio_codec_name');
            assertNoMatch(result[0], 'subtitle_codec_name');
            assertMatches(result[1], 'MediaLogProperty');
        });

        it('profile prefix wildcards with config function', () => {
            const result = parseQueryAsAndOr('(HEVCPROFILE_*|AV1PROFILE_*) GetSupported*Configs');
            assert.strictEqual(result.length, 2);
            assertMatches(result[0], 'HEVCPROFILE_MAIN');
            assertMatches(result[0], 'HEVCPROFILE_MAIN10');
            assertMatches(result[0], 'AV1PROFILE_MAIN');
            assertNoMatch(result[0], 'VP9PROFILE_0');
            assertMatches(result[1], 'GetSupportedVideoDecoderConfigs');
            assertMatches(result[1], 'GetSupportedConfigs');
        });

        it('D3D version OR with function wildcard', () => {
            const result = parseQueryAsAndOr('(D3D11|D3D12) GetSupported*Configs');
            assert.strictEqual(result.length, 2);
            assertMatches(result[0], 'D3D11');
            assertMatches(result[0], 'D3D12');
            assertNoMatch(result[0], 'D3D10');
            assertMatches(result[1], 'GetSupportedDecoderConfigs');
        });

        it('simple AND query without OR groups', () => {
            const result = parseQueryAsAndOr('GetSupportedVideoDecoderConfigs D3D11');
            assert.strictEqual(result.length, 2);
            assertMatches(result[0], 'GetSupportedVideoDecoderConfigs');
            assertMatches(result[1], 'D3D11');
        });
    });
});
