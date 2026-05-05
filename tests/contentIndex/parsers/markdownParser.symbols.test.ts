// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Tests for the Markdown parser ({@link markdownParser}).
 *
 * Exercises the full IFileParser contract:
 *   extractSymbols() — CST → raw symbol arrays
 *   hydrateSymbols() — raw symbol arrays → IndexSymbol[]
 *
 * This test can be run from the command line with:
 * npx tsc -p tests/tsconfig.json; node --test out-test/tests/common/index/parsers/markdownParser.symbols.test.js
 */

import { describe, it, before } from 'node:test';
import * as assert from 'node:assert/strict';
import { Parser, Language } from 'web-tree-sitter';
import { markdownParser } from '../../../../src/common/index/parsers/markdown/markdownParser';
import { SymbolType } from '../../../../src/common/index/parsers/types';
import {
    toComparable,
    expectedSymbol,
    filterSymbols,
    debugPrintSyntaxTree,
    setUniformTokenizer,
    getWasmPath,
} from './parserTestUtils';

// ── Paths ───────────────────────────────────────────────────────────────────

/** WASM grammar for Markdown (block-level only) */
const MD_WASM = getWasmPath('markdown.wasm');

// ── Shared state ────────────────────────────────────────────────────────────

let parser: InstanceType<typeof Parser>;
let mdLanguage: Language;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse a Markdown source string through the full extractSymbols → hydrateSymbols
 * pipeline. Returns everything needed for assertions.
 *
 * Set `debug: true` to print the tree-sitter syntax tree to stdout
 * for position verification.
 */
function parseFixture(source: string, filePath: string = 'test.md', debug: boolean = false) {
    const tree = parser.parse(source);
    assert.ok(tree, `tree-sitter failed to parse ${filePath}`);
    const rawSymbols = markdownParser.extractSymbols(tree.rootNode, filePath);
    const symbols = markdownParser.hydrateSymbols(rawSymbols);
    const lines = source.split('\n');
    if (debug) {
        console.log(debugPrintSyntaxTree(tree.rootNode));
    }
    return { filePath, source, lines, rawSymbols, symbols };
}

// ── Setup (runs once before all tests) ──────────────────────────────────────

before(async () => {
    await Parser.init();
    mdLanguage = await Language.load(MD_WASM);
    parser = new Parser();
    parser.setLanguage(mdLanguage);
    setUniformTokenizer(0.3);
});

// ── extractSymbols + hydrateSymbols ──────────────────────────────────────

// ── H1 heading ──────────────────────────────────────────────────────────────

const SINGLE_H1_SOURCE = `\
# Overview
`;

describe('single H1 heading', () => {
    it('should extract the heading with correct type and name', () => {
        const { symbols } = parseFixture(SINGLE_H1_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.MarkdownHeading1 });
        assert.equal(filtered.length, 1);
        assert.equal(filtered[0].name, 'Overview');
    });

    it('should have correct name positions', () => {
        const { symbols } = parseFixture(SINGLE_H1_SOURCE);
        const actual = symbols.map(toComparable);
        const sym = filterSymbols(actual, { type: SymbolType.MarkdownHeading1 })[0];
        // "Overview" starts after "# " at column 2
        assert.equal(sym.nameStartLine, 0);
        assert.equal(sym.nameStartColumn, 2);
        assert.equal(sym.nameEndLine, 0);
        assert.equal(sym.nameEndColumn, 10);
    });

    it('should have section extent starting at the heading', () => {
        const { symbols } = parseFixture(SINGLE_H1_SOURCE);
        const actual = symbols.map(toComparable);
        const sym = filterSymbols(actual, { type: SymbolType.MarkdownHeading1 })[0];
        assert.equal(sym.startLine, 0);
        assert.equal(sym.startColumn, 0);
        assert.equal(sym.endLine, 0);
        assert.equal(sym.endColumn, 10);
    });

    it('should produce the exact expected symbol', () => {
        const { symbols } = parseFixture(SINGLE_H1_SOURCE);
        const actual = symbols.map(toComparable);
        assert.equal(actual.length, 1);
        assert.deepStrictEqual(actual[0], expectedSymbol(
            SymbolType.MarkdownHeading1, 'Overview',
            0, 0, 0, 10,    // section extent: heading line only
            0, 2, 0, 10,    // name: "Overview" at col 2..10
        ));
    });
});

const H1_WITH_BODY_SOURCE = `\
# Overview

Some text here.
`;

describe('H1 heading with body text', () => {
    it('should produce one MarkdownHeading1 symbol', () => {
        const { symbols } = parseFixture(H1_WITH_BODY_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.MarkdownHeading1 });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.MarkdownHeading1, 'Overview',
            0, 0, 2, 15,    // section extent: line 0..2
            0, 2, 0, 10,    // name: "Overview" at col 2..10
        );
        assert.deepStrictEqual(filtered[0], expected);
    });
});

// ── H2 heading ──────────────────────────────────────────────────────────────

const SINGLE_H2_SOURCE = `\
## Details

Some details.
`;

describe('single H2 heading', () => {
    it('should produce one MarkdownHeading2 symbol', () => {
        const { symbols } = parseFixture(SINGLE_H2_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.MarkdownHeading2 });
        assert.equal(filtered.length, 1);
        assert.equal(filtered[0].name, 'Details');
    });

    it('should have correct name positions (starts at column 3 after "## ")', () => {
        const { symbols } = parseFixture(SINGLE_H2_SOURCE);
        const actual = symbols.map(toComparable);
        const sym = filterSymbols(actual, { type: SymbolType.MarkdownHeading2 })[0];
        assert.equal(sym.nameStartLine, 0);
        assert.equal(sym.nameStartColumn, 3);
        assert.equal(sym.nameEndLine, 0);
        assert.equal(sym.nameEndColumn, 10);
    });

    it('should have section extent starting at the heading', () => {
        const { symbols } = parseFixture(SINGLE_H2_SOURCE);
        const actual = symbols.map(toComparable);
        const sym = filterSymbols(actual, { type: SymbolType.MarkdownHeading2 })[0];
        assert.equal(sym.startLine, 0);
        assert.equal(sym.startColumn, 0);
        assert.equal(sym.endLine, 2);
        assert.equal(sym.endColumn, 13);
    });

    it('should produce the exact expected symbol', () => {
        const { symbols } = parseFixture(SINGLE_H2_SOURCE);
        const actual = symbols.map(toComparable);
        assert.equal(actual.length, 1);
        assert.deepStrictEqual(actual[0], expectedSymbol(
            SymbolType.MarkdownHeading2, 'Details',
            0, 0, 2, 13,    // section extent: line 0..2
            0, 3, 0, 10,    // name: "Details" at col 3..10
        ));
    });
});

// ── H3+ headings (ignored) ─────────────────────────────────────────────────

const H3_ONLY_SOURCE = `\
### Subsection

Content under H3.

#### Even Deeper

More content.
`;

describe('H3 and deeper headings', () => {
    it('should not produce any symbols', () => {
        const { symbols } = parseFixture(H3_ONLY_SOURCE);
        assert.equal(symbols.length, 0);
    });
});

// ── Nested H2 inside H1 ────────────────────────────────────────────────────

const NESTED_H2_SOURCE = `\
# Chapter 1

Intro text.

## Section 1.1

Section content.
`;

describe('H1 with nested H2', () => {
    it('should produce both MarkdownHeading1 and MarkdownHeading2 symbols', () => {
        const { symbols } = parseFixture(NESTED_H2_SOURCE);
        const actual = symbols.map(toComparable);
        const h1s = filterSymbols(actual, { type: SymbolType.MarkdownHeading1 });
        const h2s = filterSymbols(actual, { type: SymbolType.MarkdownHeading2 });
        assert.equal(h1s.length, 1);
        assert.equal(h2s.length, 1);
        assert.equal(h1s[0].name, 'Chapter 1');
        assert.equal(h2s[0].name, 'Section 1.1');
    });

    it('H2 section should be nested within H1 section extent', () => {
        const { symbols } = parseFixture(NESTED_H2_SOURCE);
        const actual = symbols.map(toComparable);
        const h1 = filterSymbols(actual, { type: SymbolType.MarkdownHeading1 })[0];
        const h2 = filterSymbols(actual, { type: SymbolType.MarkdownHeading2 })[0];
        // H2 startLine should be >= H1 startLine
        assert.ok(h2.startLine >= h1.startLine, 'H2 should start at or after H1');
        // H2 endLine should be <= H1 endLine
        assert.ok(h2.endLine <= h1.endLine, 'H2 should end at or before H1');
    });

    it('should produce 2 symbols', () => {
        const { symbols } = parseFixture(NESTED_H2_SOURCE);
        const actual = symbols.map(toComparable);

        const filtered = filterSymbols(actual, { type: SymbolType.MarkdownHeading1 });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.MarkdownHeading1, 'Chapter 1',
            0, 0, 6, 16,
            0, 2, 0, 11,
        );
        assert.deepStrictEqual(filtered[0], expected);

        const filtered2 = filterSymbols(actual, { type: SymbolType.MarkdownHeading2 });
        assert.equal(filtered2.length, 1);
        const expected2 = expectedSymbol(
            SymbolType.MarkdownHeading2, 'Section 1.1',
            4, 0, 6, 16,
            4, 3, 4, 14,
        );
        assert.deepStrictEqual(filtered2[0], expected2);
    });
});

// ── Multiple H1 headings (sibling sections) ────────────────────────────────

const MULTIPLE_H1_SOURCE = `\
# Chapter 1

Content 1.

# Chapter 2

Content 2.
`;

describe('multiple H1 headings', () => {
    it('should produce two MarkdownHeading1 symbols', () => {
        const { symbols } = parseFixture(MULTIPLE_H1_SOURCE);
        const actual = symbols.map(toComparable);
        const h1s = filterSymbols(actual, { type: SymbolType.MarkdownHeading1 });
        assert.equal(h1s.length, 2);
        assert.equal(h1s[0].name, 'Chapter 1');
        assert.equal(h1s[1].name, 'Chapter 2');
    });

    it('sibling sections should not overlap', () => {
        const { symbols } = parseFixture(MULTIPLE_H1_SOURCE);
        const actual = symbols.map(toComparable);
        const h1s = filterSymbols(actual, { type: SymbolType.MarkdownHeading1 });
        assert.ok(h1s[1].startLine > h1s[0].endLine,
            'second section should start after first section ends');
    });

    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(MULTIPLE_H1_SOURCE);
        const actual = symbols.map(toComparable);
        assert.equal(actual.length, 2);
        assert.deepStrictEqual(actual[0], expectedSymbol(
            SymbolType.MarkdownHeading1, 'Chapter 1',
            0, 0, 2, 10,    // section extent: line 0..2
            0, 2, 0, 11,    // name: "Chapter 1" at col 2..11
        ));
        assert.deepStrictEqual(actual[1], expectedSymbol(
            SymbolType.MarkdownHeading1, 'Chapter 2',
            4, 0, 6, 10,    // section extent: line 4..6
            4, 2, 4, 11,    // name: "Chapter 2" at col 2..11
        ));
    });
});

// ── Heading with inline Markdown ────────────────────────────────────────────

const INLINE_MARKDOWN_SOURCE = `\
# Hello **world**

Some text.
`;

describe('heading with inline Markdown formatting', () => {
    it('should keep raw inline Markdown in the name', () => {
        const { symbols } = parseFixture(INLINE_MARKDOWN_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.MarkdownHeading1 });
        assert.equal(filtered.length, 1);
        assert.equal(filtered[0].name, 'Hello **world**');
    });

    it('should produce the exact expected symbol', () => {
        const { symbols } = parseFixture(INLINE_MARKDOWN_SOURCE);
        const actual = symbols.map(toComparable);
        assert.equal(actual.length, 1);
        assert.deepStrictEqual(actual[0], expectedSymbol(
            SymbolType.MarkdownHeading1, 'Hello **world**',
            0, 0, 2, 10,    // section extent: line 0..2
            0, 2, 0, 17,    // name: "Hello **world**" at col 2..17
        ));
    });
});

// ── Heading with code in name ───────────────────────────────────────────────

const CODE_IN_HEADING_SOURCE = `\
## The \`parse\` function

Description.
`;

describe('heading with backtick code in name', () => {
    it('should keep backtick markers in the name', () => {
        const { symbols } = parseFixture(CODE_IN_HEADING_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.MarkdownHeading2 });
        assert.equal(filtered.length, 1);
        assert.equal(filtered[0].name, 'The `parse` function');
    });

    it('should produce the exact expected symbol', () => {
        const { symbols } = parseFixture(CODE_IN_HEADING_SOURCE);
        const actual = symbols.map(toComparable);
        assert.equal(actual.length, 1);
        assert.deepStrictEqual(actual[0], expectedSymbol(
            SymbolType.MarkdownHeading2, 'The `parse` function',
            0, 0, 2, 12,    // section extent: line 0..2
            0, 3, 0, 23,    // name: "The `parse` function" at col 3..23
        ));
    });
});

// ── Multiple H1 with nested H2 headings ────────────────────────────────────

const COMPLEX_STRUCTURE_SOURCE = `\
# Introduction

Welcome text.

## Background

Background info.

# API Reference

API overview.

## Methods

Method details.

## Events

Event details.
`;

describe('complex heading structure (multiple H1 with nested H2)', () => {
    it('should produce all H1 and H2 symbols', () => {
        const { symbols } = parseFixture(COMPLEX_STRUCTURE_SOURCE);
        const actual = symbols.map(toComparable);
        const h1s = filterSymbols(actual, { type: SymbolType.MarkdownHeading1 });
        const h2s = filterSymbols(actual, { type: SymbolType.MarkdownHeading2 });
        assert.equal(h1s.length, 2, 'expected 2 H1 headings');
        assert.equal(h2s.length, 3, 'expected 3 H2 headings');
        assert.equal(h1s[0].name, 'Introduction');
        assert.equal(h1s[1].name, 'API Reference');
        assert.equal(h2s[0].name, 'Background');
        assert.equal(h2s[1].name, 'Methods');
        assert.equal(h2s[2].name, 'Events');
    });

    it('H2 "Background" should nest inside H1 "Introduction"', () => {
        const { symbols } = parseFixture(COMPLEX_STRUCTURE_SOURCE);
        const actual = symbols.map(toComparable);
        const intro = filterSymbols(actual, { name: 'Introduction' })[0];
        const bg = filterSymbols(actual, { name: 'Background' })[0];
        assert.ok(bg.startLine >= intro.startLine);
        assert.ok(bg.endLine <= intro.endLine);
    });

    it('H2 "Methods" and "Events" should nest inside H1 "API Reference"', () => {
        const { symbols } = parseFixture(COMPLEX_STRUCTURE_SOURCE);
        const actual = symbols.map(toComparable);
        const api = filterSymbols(actual, { name: 'API Reference' })[0];
        const methods = filterSymbols(actual, { name: 'Methods' })[0];
        const events = filterSymbols(actual, { name: 'Events' })[0];
        assert.ok(methods.startLine >= api.startLine);
        assert.ok(methods.endLine <= api.endLine);
        assert.ok(events.startLine >= api.startLine);
        assert.ok(events.endLine <= api.endLine);
    });

    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(COMPLEX_STRUCTURE_SOURCE);
        const actual = symbols.map(toComparable);
        assert.equal(actual.length, 5);
        assert.deepStrictEqual(actual[0], expectedSymbol(
            SymbolType.MarkdownHeading1, 'Introduction',
            0, 0, 6, 16,    // section extent: line 0..6
            0, 2, 0, 14,    // name: "Introduction" at col 2..14
        ));
        assert.deepStrictEqual(actual[1], expectedSymbol(
            SymbolType.MarkdownHeading2, 'Background',
            4, 0, 6, 16,    // section extent: line 4..6
            4, 3, 4, 13,    // name: "Background" at col 3..13
        ));
        assert.deepStrictEqual(actual[2], expectedSymbol(
            SymbolType.MarkdownHeading1, 'API Reference',
            8, 0, 18, 14,   // section extent: line 8..18
            8, 2, 8, 15,    // name: "API Reference" at col 2..15
        ));
        assert.deepStrictEqual(actual[3], expectedSymbol(
            SymbolType.MarkdownHeading2, 'Methods',
            12, 0, 14, 15,  // section extent: line 12..14
            12, 3, 12, 10,  // name: "Methods" at col 3..10
        ));
        assert.deepStrictEqual(actual[4], expectedSymbol(
            SymbolType.MarkdownHeading2, 'Events',
            16, 0, 18, 14,  // section extent: line 16..18
            16, 3, 16, 9,   // name: "Events" at col 3..9
        ));
    });
});

// ── H3 inside H2 (H3 ignored, content included in H2 extent) ───────────────

const H3_INSIDE_H2_SOURCE = `\
## Section A

Content A.

### Subsection A.1

Sub content.
`;

describe('H3 inside H2 (H3 ignored)', () => {
    it('should only produce the H2 symbol', () => {
        const { symbols } = parseFixture(H3_INSIDE_H2_SOURCE);
        const actual = symbols.map(toComparable);
        assert.equal(actual.length, 1);
        assert.equal(actual[0].type, SymbolType.MarkdownHeading2);
        assert.equal(actual[0].name, 'Section A');
    });

    it('H2 extent should include H3 content', () => {
        const { symbols } = parseFixture(H3_INSIDE_H2_SOURCE);
        const actual = symbols.map(toComparable);
        const h2 = actual[0];
        // The H2 section should extend past the H3 heading and its content
        assert.ok(h2.endLine >= 6, 'H2 extent should cover H3 sub-content');
    });

    it('should produce the exact expected symbol', () => {
        const { symbols } = parseFixture(H3_INSIDE_H2_SOURCE);
        const actual = symbols.map(toComparable);
        assert.equal(actual.length, 1);
        assert.deepStrictEqual(actual[0], expectedSymbol(
            SymbolType.MarkdownHeading2, 'Section A',
            0, 0, 6, 12,    // section extent: line 0..6 (includes H3 content)
            0, 3, 0, 12,    // name: "Section A" at col 3..12
        ));
    });
});

// ── No headings ─────────────────────────────────────────────────────────────

const NO_HEADINGS_SOURCE = `\
Just some text.

More text here.
`;

describe('no headings', () => {
    it('should produce no symbols', () => {
        const { symbols } = parseFixture(NO_HEADINGS_SOURCE);
        assert.equal(symbols.length, 0);
    });
});

// ── hydrateSymbols round-trip ────────────────────────────────────────────

describe('hydrateSymbols round-trip', () => {
    it('extractSymbols → hydrateSymbols → extractSymbols → hydrateSymbols should produce identical symbols', () => {
        const source = `\
# Title

Paragraph.

## Subtitle

More text.
`;
        const { rawSymbols, symbols } = parseFixture(source);
        // Re-hydrate from the same raw data
        const rehydrated = markdownParser.hydrateSymbols(rawSymbols);
        assert.equal(symbols.length, rehydrated.length);
        for (let i = 0; i < symbols.length; i++) {
            assert.deepStrictEqual(toComparable(symbols[i]), toComparable(rehydrated[i]));
        }
    });
});
