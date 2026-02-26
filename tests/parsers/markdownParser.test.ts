// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Tests for the Markdown parser ({@link markdownParser}).
 *
 * Exercises the full IFileParser contract:
 *   parseCst()      — CST → raw symbol arrays
 *   readIndex()     — raw symbol arrays → IndexSymbol[]
 *   computeChunks() — source lines + symbols → Chunk[]
 *
 * This test can be run from the command line with:
 * npx tsc -p tsconfig.test.json; node --test out-test/tests/parsers/markdownParser.test.js
 */

import { describe, it, before } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { Parser, Language } from 'web-tree-sitter';
import { markdownParser } from '../../src/common/index/parsers/markdownParser';
import { SymbolType } from '../../src/common/index/parsers/types';
import {
    toComparable, expectedSymbol, filterSymbols, debugPrintSyntaxTree
} from './parserTestUtils';

// ── Paths ───────────────────────────────────────────────────────────────────

/** Project root (three levels up from out-test/tests/parsers/) */
const ROOT = path.resolve(__dirname, '..', '..', '..');

/** WASM grammar for Markdown (block-level only) */
const MD_WASM = path.join(ROOT, 'bin', 'tree-sitter', 'languages', 'markdown.wasm');

// ── Shared state ────────────────────────────────────────────────────────────

let parser: InstanceType<typeof Parser>;
let mdLanguage: Language;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse a Markdown source string through the full parseCst → readIndex
 * pipeline. Returns everything needed for assertions.
 *
 * Set `debug: true` to print the tree-sitter syntax tree to stdout
 * for position verification.
 */
function parseFixture(source: string, filePath: string = 'test.md', debug: boolean = false) {
    const tree = parser.parse(source);
    assert.ok(tree, `tree-sitter failed to parse ${filePath}`);
    const rawSymbols = markdownParser.parseCst(tree.rootNode, filePath);
    const symbols = markdownParser.readIndex(rawSymbols);
    const lines = source.split('\n');
    if (debug) {
        console.log(debugPrintSyntaxTree(tree.rootNode));
    }
    return { filePath, source, lines, rawSymbols, symbols };
}

/**
 * Compute chunks through the full parseCst → readIndex → computeChunks
 * pipeline.
 */
function chunkFixture(source: string, filePath: string = 'test.md') {
    const { symbols, lines } = parseFixture(source, filePath);
    const chunks = markdownParser.computeChunks(lines, symbols, filePath);
    return { symbols, lines, chunks };
}

// ── Setup (runs once before all tests) ──────────────────────────────────────

before(async () => {
    await Parser.init();
    mdLanguage = await Language.load(MD_WASM);
    parser = new Parser();
    parser.setLanguage(mdLanguage);
});

// ── parseCst + readIndex ────────────────────────────────────────────────────

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

// ── readIndex round-trip ────────────────────────────────────────────────────

describe('readIndex round-trip', () => {
    it('parseCst → readIndex → parseCst → readIndex should produce identical symbols', () => {
        const source = `\
# Title

Paragraph.

## Subtitle

More text.
`;
        const { rawSymbols, symbols } = parseFixture(source);
        // Re-hydrate from the same raw data
        const rehydrated = markdownParser.readIndex(rawSymbols);
        assert.equal(symbols.length, rehydrated.length);
        for (let i = 0; i < symbols.length; i++) {
            assert.deepStrictEqual(toComparable(symbols[i]), toComparable(rehydrated[i]));
        }
    });
});

// ── computeChunks ───────────────────────────────────────────────────────────

const CHUNK_SINGLE_SECTION_SOURCE = `\
# Overview

This is an overview section with enough text to meet the minimum chunk
size requirement. We need at least 75 characters in the chunk for it to
be retained by the chunking logic. This paragraph provides that.
`;

describe('chunking: single heading section', () => {
    it('should produce at least one chunk', () => {
        const { chunks } = chunkFixture(CHUNK_SINGLE_SECTION_SOURCE);
        assert.ok(chunks.length == 1, 'expected one chunk');
    });

    it('chunks should have heading-aware context prefix', () => {
        const { chunks } = chunkFixture(CHUNK_SINGLE_SECTION_SOURCE);
        assert.ok(chunks[0].text.includes('file: test.md'),
            'chunk should include file path prefix');
        assert.ok(chunks[0].text.includes('section: Overview'),
            'chunk should include heading section name prefix');
    });

    it('chunks should have SHA-256 digests', () => {
        const { chunks } = chunkFixture(CHUNK_SINGLE_SECTION_SOURCE);
        for (const chunk of chunks) {
            assert.ok(chunk.sha256, 'chunk should have a sha256 digest');
            assert.equal(chunk.sha256.length, 64, 'sha256 should be 64 hex chars');
        }
    });

    it('chunk line numbers should be 1-based', () => {
        const { chunks } = chunkFixture(CHUNK_SINGLE_SECTION_SOURCE);
        for (const chunk of chunks) {
            assert.ok(chunk.startLine == 1, 'startLine should be 1-based');
            assert.ok(chunk.endLine == 5, 'endLine should be 5');
        }
    });
});

const CHUNK_MULTIPLE_SECTIONS_SOURCE = `\
# Chapter 1

This is the first chapter with sufficient content to meet the minimum
chunk size requirement of seventy-five characters in total length for
the embedding chunks to be generated correctly by the chunking system.

# Chapter 2

This is the second chapter with sufficient content to meet the minimum
chunk size requirement of seventy-five characters in total length for
the embedding chunks to be generated correctly by the chunking system.
`;

describe('chunking: multiple heading sections', () => {
    it('should produce chunks for each section', () => {
        const { chunks } = chunkFixture(CHUNK_MULTIPLE_SECTIONS_SOURCE);
        const ch1Chunk = chunks.find(c => c.text.includes('first chapter'));
        const ch2Chunk = chunks.find(c => c.text.includes('second chapter'));
        assert.ok(ch1Chunk, 'expected a chunk for Chapter 1');
        assert.ok(ch2Chunk, 'expected a chunk for Chapter 2');
        assert.ok(chunks.length == 2, 'expected two chunks');
    });

    it('each section chunk should have the correct heading prefix', () => {
        const { chunks } = chunkFixture(CHUNK_MULTIPLE_SECTIONS_SOURCE);
        const ch1Chunk = chunks.find(c => c.text.includes('first chapter'));
        const ch2Chunk = chunks.find(c => c.text.includes('second chapter'));
        assert.ok(ch1Chunk!.text.includes('section: Chapter 1'));
        assert.ok(!ch1Chunk!.text.includes('section: Chapter 2'));
        assert.ok(ch2Chunk!.text.includes('section: Chapter 2'));
        assert.ok(!ch2Chunk!.text.includes('section: Chapter 1'));
    });

    it('each chunk should have correct line numbers', () => {
        const { chunks } = chunkFixture(CHUNK_MULTIPLE_SECTIONS_SOURCE);
        assert.equal(chunks[0].startLine, 1);
        assert.equal(chunks[0].endLine, 5);
        assert.equal(chunks[1].startLine, 7);
        assert.equal(chunks[1].endLine, 11);
    });
});

const CHUNK_CONTENT_BEFORE_HEADING_SOURCE = `\
Some introductory text before any heading appears in the document. This
needs to be long enough to meet the minimum chunk character threshold of
seventy-five characters so that it is not filtered out by the chunker.

# First Heading

Content under the first heading with sufficient length to meet the
minimum chunk size requirement of seventy-five characters in total.
`;

describe('chunking: content before first heading', () => {
    it('should produce a gap chunk for the intro and a section chunk', () => {
        const { chunks } = chunkFixture(CHUNK_CONTENT_BEFORE_HEADING_SOURCE);
        assert.ok(chunks.length == 2, 'expected two chunks');
        const introChunk = chunks.find(c => c.text.includes('introductory'));
        const headingChunk = chunks.find(c => c.text.includes('First Heading'));
        assert.ok(introChunk, 'expected a chunk for intro content');
        assert.ok(headingChunk, 'expected a chunk for heading section');
    });

    it('intro chunk should have file-only prefix (no heading)', () => {
        const { chunks } = chunkFixture(CHUNK_CONTENT_BEFORE_HEADING_SOURCE);
        const introChunk = chunks.find(c => c.text.includes('introductory'))!;
        assert.ok(introChunk.text.includes('file: test.md'));
        assert.ok(!introChunk.text.includes('section:'),
            'intro chunk should not have a heading prefix');
    });

    it('each chunk should have correct line numbers', () => {
        const { chunks } = chunkFixture(CHUNK_CONTENT_BEFORE_HEADING_SOURCE);
        assert.equal(chunks[0].startLine, 1);
        assert.equal(chunks[0].endLine, 3);
        assert.equal(chunks[1].startLine, 5);
        assert.equal(chunks[1].endLine, 8);
    });
});

// ── Breadcrumb prefixes for nested H2 sections ─────────────────────────────

const CHUNK_BREADCRUMB_SOURCE = `\
# API Reference

API overview text with enough content to meet the minimum chunk size
requirement of seventy-five characters for the embedding chunk system.

## Methods

Method details with enough content to meet the minimum chunk size
requirement of seventy-five characters for the embedding chunk system.

## Events

Event details with enough content to meet the minimum chunk size
requirement of seventy-five characters for the embedding chunk system.
`;

describe('chunking: breadcrumb prefixes for nested H2', () => {
    it('H1 intro chunk should have H1-only section prefix', () => {
        const { chunks } = chunkFixture(CHUNK_BREADCRUMB_SOURCE);
        assert.ok(chunks.length == 3);
        const introChunk = chunks.find(c => c.text.includes('API overview'));
        assert.ok(introChunk, 'expected a chunk for H1 intro');
        assert.ok(introChunk!.text.includes('section: API Reference'),
            'H1 intro chunk should have H1 name in prefix');
        assert.ok(!introChunk!.text.includes('>'),
            'H1 intro chunk should not have a breadcrumb separator');
    });

    it('H2 chunks should have breadcrumb prefix (H1 > H2)', () => {
        const { chunks } = chunkFixture(CHUNK_BREADCRUMB_SOURCE);
        const methodsChunk = chunks.find(c => c.text.includes('Method details'));
        const eventsChunk = chunks.find(c => c.text.includes('Event details'));
        assert.ok(methodsChunk, 'expected a chunk for Methods');
        assert.ok(eventsChunk, 'expected a chunk for Events');
        assert.ok(methodsChunk!.text.includes('section: API Reference > Methods'),
            'Methods chunk should have breadcrumb prefix');
        assert.ok(eventsChunk!.text.includes('section: API Reference > Events'),
            'Events chunk should have breadcrumb prefix');
    });

    it('should produce separate chunks for H1 intro, Methods, and Events', () => {
        const { chunks } = chunkFixture(CHUNK_BREADCRUMB_SOURCE);
        const introChunk = chunks.find(c => c.text.includes('API overview'));
        const methodsChunk = chunks.find(c => c.text.includes('Method details'));
        const eventsChunk = chunks.find(c => c.text.includes('Event details'));
        assert.ok(introChunk, 'expected H1 intro chunk');
        assert.ok(methodsChunk, 'expected Methods chunk');
        assert.ok(eventsChunk, 'expected Events chunk');
    });

    it('each chunk should have correct line numbers', () => {
        const { chunks } = chunkFixture(CHUNK_BREADCRUMB_SOURCE);
        // H1 intro: lines 1..4 (# API Reference + body, before ## Methods)
        assert.equal(chunks[0].startLine, 1);
        assert.equal(chunks[0].endLine, 4);
        // ## Methods section: lines 6..9
        assert.equal(chunks[1].startLine, 6);
        assert.equal(chunks[1].endLine, 9);
        // ## Events section: lines 11..14
        assert.equal(chunks[2].startLine, 11);
        assert.equal(chunks[2].endLine, 14);
    });
});

// ── Standalone H2 (no parent H1) ───────────────────────────────────────────

const CHUNK_STANDALONE_H2_SOURCE = `\
## Standalone Section

Standalone section content with enough text to meet the minimum chunk
size requirement of seventy-five characters for the embedding system.
`;

describe('chunking: standalone H2 (no parent H1)', () => {
    it('should have H2 name only in prefix (no breadcrumb)', () => {
        const { chunks } = chunkFixture(CHUNK_STANDALONE_H2_SOURCE);
        assert.ok(chunks.length == 1);
        assert.ok(chunks[0].text.includes('section: Standalone Section'));
        assert.ok(!chunks[0].text.includes('>'),
            'standalone H2 should not have a breadcrumb separator');
    });

    it('chunk should have correct line numbers', () => {
        const { chunks } = chunkFixture(CHUNK_STANDALONE_H2_SOURCE);
        assert.equal(chunks[0].startLine, 1);
        assert.equal(chunks[0].endLine, 4);
    });
});

// ── Empty sections (heading only, no body) ──────────────────────────────────

const CHUNK_EMPTY_H1_BEFORE_H2_SOURCE = `\
# Title

## Real Content

This section has enough content to meet the minimum chunk size requirement
of seventy-five characters for the embedding chunks to be generated here.
`;

describe('chunking: empty H1 section before H2', () => {
    it('should skip the empty H1 intro and only chunk the H2', () => {
        const { chunks } = chunkFixture(CHUNK_EMPTY_H1_BEFORE_H2_SOURCE);
        assert.ok(chunks.length == 1);
        // The H1 has no body text before the H2, so no H1-only chunk
        const h1OnlyChunk = chunks.find(c =>
            c.text.includes('section: Title') && !c.text.includes('>'));
        assert.ok(!h1OnlyChunk,
            'should not produce a chunk for the empty H1 intro');
        // The H2 should still get a breadcrumb chunk
        const h2Chunk = chunks.find(c => c.text.includes('Real Content'));
        assert.ok(h2Chunk, 'expected a chunk for the H2 section');
        assert.ok(h2Chunk.text.includes('section: Title > Real Content'));
    });

    it('chunk should have correct line numbers', () => {
        const { chunks } = chunkFixture(CHUNK_EMPTY_H1_BEFORE_H2_SOURCE);
        assert.equal(chunks[0].startLine, 3);
        assert.equal(chunks[0].endLine, 6);
    });
});

const CHUNK_EMPTY_H2_SOURCE = `\
# Overview

Intro text with enough content to meet the minimum chunk size threshold
of seventy-five characters for the embedding chunks to be generated ok.

## Empty Section

## Content Section

This section has enough content to meet the minimum chunk size requirement
of seventy-five characters for the embedding chunks to be generated here.
`;

describe('chunking: empty H2 section', () => {
    it('should skip the empty H2 and chunk the others', () => {
        const { chunks } = chunkFixture(CHUNK_EMPTY_H2_SOURCE);
        assert.ok(chunks.length == 2);
        const emptyChunk = chunks.find(c =>
            c.text.includes('section: Overview > Empty Section'));
        assert.ok(!emptyChunk,
            'should not produce a chunk for the empty H2 section');
        const contentChunk = chunks.find(c =>
            c.text.includes('section: Overview > Content Section'));
        assert.ok(contentChunk,
            'expected a chunk for the non-empty H2 section');
    });

    it('each chunk should have correct line numbers', () => {
        const { chunks } = chunkFixture(CHUNK_EMPTY_H2_SOURCE);
        // H1 intro: lines 1..4 (# Overview + body, before ## Empty Section)
        assert.equal(chunks[0].startLine, 1);
        assert.equal(chunks[0].endLine, 4);
        // ## Content Section: lines 8..11
        assert.equal(chunks[1].startLine, 8);
        assert.equal(chunks[1].endLine, 11);
    });
});

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
    it('parseCst with null rootNode should return empty array', () => {
        const result = markdownParser.parseCst(null, 'test.md');
        assert.deepStrictEqual(result, []);
    });

    it('readIndex with empty array should return empty array', () => {
        const result = markdownParser.readIndex([]);
        assert.deepStrictEqual(result, []);
    });

    it('computeChunks with empty source should return empty array', () => {
        const chunks = markdownParser.computeChunks([], [], 'empty.md');
        assert.deepStrictEqual(chunks, []);
    });

    it('computeChunks with no symbols should still produce chunks if file has content', () => {
        const lines = [
            'This is a plain text file without any headings at all.',
            'It has multiple lines of content that should still be chunked.',
            'The chunking system needs enough text to meet the minimum threshold.',
            'So we add a few more lines here to make sure we exceed it safely.',
        ];
        const chunks = markdownParser.computeChunks(lines, [], 'plain.md');
        assert.ok(chunks.length == 1, 'expected one chunk from non-empty file');
    });
});
