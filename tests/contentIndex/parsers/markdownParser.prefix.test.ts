// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Tests for the Markdown parser ({@link markdownParser}).
 *
 * This test can be run from the command line with:
 * npx tsc -p tests/tsconfig.json; node --test out-test/tests/contentIndex/parsers/markdownParser.prefix.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { markdownParser } from '../../../src/contentIndex/parsers/markdown/markdownParser';
import {
    _buildContextPrefix as buildContextPrefix,
    _FILE_ONLY_OVERHEAD as FILE_ONLY_OVERHEAD,
    _FULL_PREFIX_OVERHEAD as FULL_PREFIX_OVERHEAD,
} from '../../../src/contentIndex/parsers/markdown/chunker';

// ── buildContextPrefix ──────────────────────────────────────────────────────

describe('buildContextPrefix', () => {

    const filePath = 'docs/getting-started.md';
    const GENEROUS_BUDGET = 500;

    // ── Full prefix (with section) ──────────────────────────────────────

    it('produces full prefix with file path and section breadcrumb', () => {
        const section = { startLine: 0, endLine: 10, breadcrumb: 'API Reference > Methods' };
        const result = buildContextPrefix(filePath, GENEROUS_BUDGET, section);
        assert.equal(result, `---\nfile: ${filePath}\nsection: API Reference > Methods\n---\n\n`);
    });

    it('produces full prefix with simple section name (no breadcrumb separator)', () => {
        const section = { startLine: 0, endLine: 10, breadcrumb: 'Overview' };
        const result = buildContextPrefix(filePath, GENEROUS_BUDGET, section);
        assert.equal(result, `---\nfile: ${filePath}\nsection: Overview\n---\n\n`);
    });

    // ── Fallback: section dropped ───────────────────────────────────────

    it('drops section when full prefix exceeds budget but file path fits', () => {
        const section = { startLine: 0, endLine: 10, breadcrumb: 'Very Long Section Name That Pushes Over Budget' };
        const budget = FULL_PREFIX_OVERHEAD + filePath.length + section.breadcrumb.length - 1; // 1 char short
        const result = buildContextPrefix(filePath, budget, section);
        assert.equal(result, `---\nfile: ${filePath}\n---\n\n`);
        assert.ok(!result.includes('section:'));
    });

    // ── File path only (no section) ─────────────────────────────────────

    it('produces file-only prefix when no section is provided', () => {
        const result = buildContextPrefix(filePath, GENEROUS_BUDGET);
        assert.equal(result, `---\nfile: ${filePath}\n---\n\n`);
    });

    it('produces file-only prefix when section is undefined', () => {
        const result = buildContextPrefix(filePath, GENEROUS_BUDGET, undefined);
        assert.equal(result, `---\nfile: ${filePath}\n---\n\n`);
    });

    // ── Fallback: basename only ─────────────────────────────────────────

    it('falls back to basename when full path exceeds budget', () => {
        const longPath = 'a/'.repeat(100) + 'readme.md';
        const budget = FILE_ONLY_OVERHEAD + 12; // fits "readme.md" (9 chars) but not the full path
        const result = buildContextPrefix(longPath, budget);
        assert.equal(result, '---\nfile: readme.md\n---\n\n');
    });

    // ── Fallback: empty string ──────────────────────────────────────────

    it('returns empty string when even basename exceeds budget', () => {
        const result = buildContextPrefix('x.md', 5); // too small for anything
        assert.equal(result, '');
    });

    // ── Overhead constants are correct ──────────────────────────────────

    it('FILE_ONLY_OVERHEAD matches actual fixed text length', () => {
        const prefix = buildContextPrefix('', GENEROUS_BUDGET);
        // prefix = "---\nfile: \n---\n\n" with empty filePath
        assert.equal(prefix.length, FILE_ONLY_OVERHEAD);
    });

    it('FULL_PREFIX_OVERHEAD matches actual fixed text length', () => {
        const section = { startLine: 0, endLine: 10, breadcrumb: '' };
        const prefix = buildContextPrefix('', GENEROUS_BUDGET, section);
        // prefix = "---\nfile: \nsection: \n---\n\n" with empty filePath and breadcrumb
        assert.equal(prefix.length, FULL_PREFIX_OVERHEAD);
    });

    // ── Budget boundary (exact fit) ─────────────────────────────────────

    it('includes section when length exactly equals budget', () => {
        const section = { startLine: 0, endLine: 10, breadcrumb: 'Intro' };
        const exactBudget = FULL_PREFIX_OVERHEAD + filePath.length + section.breadcrumb.length;
        const result = buildContextPrefix(filePath, exactBudget, section);
        assert.ok(result.includes('section: Intro'));
    });

    it('drops section when length is one over budget', () => {
        const section = { startLine: 0, endLine: 10, breadcrumb: 'Intro' };
        const exactBudget = FULL_PREFIX_OVERHEAD + filePath.length + section.breadcrumb.length;
        const result = buildContextPrefix(filePath, exactBudget - 1, section);
        assert.ok(!result.includes('section:'));
        assert.ok(result.includes(`file: ${filePath}`));
    });

    it('includes file path when length exactly equals budget', () => {
        const exactBudget = FILE_ONLY_OVERHEAD + filePath.length;
        const result = buildContextPrefix(filePath, exactBudget);
        assert.equal(result, `---\nfile: ${filePath}\n---\n\n`);
    });

    it('drops file path when length is one over budget (falls back to basename)', () => {
        const exactBudget = FILE_ONLY_OVERHEAD + filePath.length;
        const result = buildContextPrefix(filePath, exactBudget - 1);
        assert.ok(!result.includes(filePath));
        assert.ok(result.includes('getting-started.md'));
    });

    // ── YAML front-matter format ────────────────────────────────────────

    it('prefix starts with YAML front-matter delimiter', () => {
        const result = buildContextPrefix(filePath, GENEROUS_BUDGET);
        assert.ok(result.startsWith('---\n'));
    });

    it('prefix ends with closing delimiter and blank line', () => {
        const result = buildContextPrefix(filePath, GENEROUS_BUDGET);
        assert.ok(result.endsWith('\n---\n\n'));
    });
});
