// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Tests for the C/C++ parser ({@link cppParser}).
 *
 * This test can be run from the command line with:
 * npx tsc -p tests/tsconfig.json; node --test out-test/tests/common/index/parsers/cppParser.prefix.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { cppParser } from '../../../../src/common/index/parsers/cpp/cppParser';
import {
    _buildContextPrefix as buildContextPrefix,
    _FILE_ONLY_OVERHEAD as FILE_ONLY_OVERHEAD,
    _CONTAINER_OVERHEAD as CONTAINER_OVERHEAD,
    _SIGNATURE_LINE_OVERHEAD as SIGNATURE_LINE_OVERHEAD,
} from '../../../../src/common/index/parsers/cpp/chunker';

// ── buildContextPrefix ──────────────────────────────────────────────────────

describe('buildContextPrefix', () => {

    const filePath = 'src/components/player.cpp';
    const GENEROUS_BUDGET = 500;

    // ── Full prefix (container + signature) ─────────────────────────────

    it('produces full prefix with container and signature when within budget', () => {
        const container = { kind: 'Function', qualifiedName: 'Player::play', signature: 'void Player::play(int vol)' };
        const result = buildContextPrefix(filePath, GENEROUS_BUDGET, container, true);
        assert.equal(result, `// file: ${filePath}\n// Function: Player::play\n// signature: void Player::play(int vol)\n\n`);
    });

    it('produces full prefix with container but no signature when includeSignature is false', () => {
        const container = { kind: 'Function', qualifiedName: 'Player::play', signature: 'void Player::play()' };
        const result = buildContextPrefix(filePath, GENEROUS_BUDGET, container, false);
        assert.equal(result, `// file: ${filePath}\n// Function: Player::play\n\n`);
        assert.ok(!result.includes('signature'));
    });

    it('does not include signature for non-SIGNATURE_KINDS (e.g. Class)', () => {
        const container = { kind: 'Class', qualifiedName: 'Player', signature: 'class Player' };
        const result = buildContextPrefix(filePath, GENEROUS_BUDGET, container, true);
        assert.equal(result, `// file: ${filePath}\n// Class: Player\n\n`);
        assert.ok(!result.includes('signature'));
    });

    it('does not include signature when container has no signature field', () => {
        const container = { kind: 'Function', qualifiedName: 'doWork' };
        const result = buildContextPrefix(filePath, GENEROUS_BUDGET, container, true);
        assert.equal(result, `// file: ${filePath}\n// Function: doWork\n\n`);
    });

    // ── Fallback: signature dropped ─────────────────────────────────────

    it('drops signature when it exceeds budget but keeps container', () => {
        const container = { kind: 'Function', qualifiedName: 'fn', signature: 'void fn()' };
        // Budget fits container but not container + signature
        const containerLen = CONTAINER_OVERHEAD + filePath.length + container.kind.length + container.qualifiedName.length;
        const budget = containerLen + SIGNATURE_LINE_OVERHEAD + container.signature.length - 1; // 1 char short
        const result = buildContextPrefix(filePath, budget, container, true);
        assert.ok(result.includes('// Function: fn'));
        assert.ok(!result.includes('signature'));
    });

    // ── Fallback: container dropped, file path only ─────────────────────

    it('falls back to file path only when container exceeds budget', () => {
        const container = { kind: 'Function', qualifiedName: 'VeryLongNamespace::VeryLongClass::VeryLongMethod' };
        // Budget fits file-only but not container
        const budget = FILE_ONLY_OVERHEAD + filePath.length;
        const result = buildContextPrefix(filePath, budget, container, false);
        assert.equal(result, `// file: ${filePath}\n\n`);
    });

    it('produces file path only when no container is provided', () => {
        const result = buildContextPrefix(filePath, GENEROUS_BUDGET);
        assert.equal(result, `// file: ${filePath}\n\n`);
    });

    // ── Fallback: basename only ─────────────────────────────────────────

    it('falls back to basename when full path exceeds budget', () => {
        const longPath = 'a/'.repeat(100) + 'file.cpp';
        const budget = FILE_ONLY_OVERHEAD + 10; // fits "file.cpp" (8 chars) but not the full path
        const result = buildContextPrefix(longPath, budget);
        assert.equal(result, '// file: file.cpp\n\n');
    });

    // ── Fallback: empty string ──────────────────────────────────────────

    it('returns empty string when even basename exceeds budget', () => {
        const result = buildContextPrefix('x.cpp', 5); // too small for anything
        assert.equal(result, '');
    });

    // ── Overhead constants are correct ──────────────────────────────────

    it('FILE_ONLY_OVERHEAD matches actual fixed text length', () => {
        const prefix = buildContextPrefix('', GENEROUS_BUDGET);
        // prefix = "// file: \n\n" with empty filePath
        assert.equal(prefix.length, FILE_ONLY_OVERHEAD);
    });

    it('CONTAINER_OVERHEAD matches actual fixed text length', () => {
        const container = { kind: '', qualifiedName: '' };
        const prefix = buildContextPrefix('', GENEROUS_BUDGET, container);
        // prefix = "// file: \n// : \n\n" with empty filePath, kind, and name
        assert.equal(prefix.length, CONTAINER_OVERHEAD);
    });

    it('SIGNATURE_LINE_OVERHEAD matches actual fixed text length', () => {
        const container = { kind: 'Function', qualifiedName: 'fn', signature: 'X' };
        const withSig = buildContextPrefix('', GENEROUS_BUDGET, container, true);
        const withoutSig = buildContextPrefix('', GENEROUS_BUDGET, container, false);
        // The difference minus the signature content ('X' = 1 char) is the overhead
        assert.equal(withSig.length - withoutSig.length - container.signature.length, SIGNATURE_LINE_OVERHEAD);
    });

    // ── Budget boundary (exact fit) ─────────────────────────────────────

    it('includes container when length exactly equals budget', () => {
        const container = { kind: 'Class', qualifiedName: 'Foo' };
        const exactBudget = CONTAINER_OVERHEAD + filePath.length + container.kind.length + container.qualifiedName.length;
        const result = buildContextPrefix(filePath, exactBudget, container);
        assert.ok(result.includes('// Class: Foo'));
    });

    it('drops container when length is one over budget', () => {
        const container = { kind: 'Class', qualifiedName: 'Foo' };
        const exactBudget = CONTAINER_OVERHEAD + filePath.length + container.kind.length + container.qualifiedName.length;
        const result = buildContextPrefix(filePath, exactBudget - 1, container);
        assert.ok(!result.includes('Class'));
        assert.ok(result.includes(`// file: ${filePath}`));
    });

    // ── SIGNATURE_KINDS coverage ────────────────────────────────────────

    it('includes signature for all SIGNATURE_KINDS', () => {
        for (const kind of ['Function', 'Method', 'Constructor', 'Destructor', 'Prototype']) {
            const container = { kind, qualifiedName: 'test', signature: 'void test()' };
            const result = buildContextPrefix(filePath, GENEROUS_BUDGET, container, true);
            assert.ok(result.includes('// signature: void test()'),
                `${kind} should include signature line`);
        }
    });

    it('excludes signature for non-SIGNATURE_KINDS', () => {
        for (const kind of ['Class', 'Struct', 'Enum', 'Union', 'Namespace']) {
            const container = { kind, qualifiedName: 'test', signature: 'some sig' };
            const result = buildContextPrefix(filePath, GENEROUS_BUDGET, container, true);
            assert.ok(!result.includes('signature'),
                `${kind} should not include signature line`);
        }
    });
});
