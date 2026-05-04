// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Tests for the Markdown parser ({@link markdownParser}).
 *
 * Exercises the full IFileParser contract:
 *   computeChunks()  — source lines + symbols → Chunk[]
 *
 * This test can be run from the command line with:
 * npx tsc -p tests/tsconfig.json; node --test out-test/tests/common/index/parsers/markdownParser.chunking.test.js
 */

import { describe, it, before } from 'node:test';
import * as assert from 'node:assert/strict';
import { Parser, Language } from 'web-tree-sitter';
import { markdownParser } from '../../../../src/common/index/parsers/markdown/markdownParser';
import {
    debugPrintSyntaxTree,
    setUniformTokenizer,
    makeChunkingConfig,
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

/**
 * Default chunking config matching the production budgets passed to
 * the parser by {@link CacheManager}.
 */
const CHUNKING_CONFIG = makeChunkingConfig(2046, 3584);

/**
 * Compute chunks through the full extractSymbols → hydrateSymbols → computeChunks
 * pipeline.
 */
async function chunkFixture(source: string, filePath: string = 'test.md') {
    const { symbols, lines } = parseFixture(source, filePath);
    const chunks = await markdownParser.computeChunks(lines, symbols, filePath, CHUNKING_CONFIG);
    return { symbols, lines, chunks };
}

// ── Setup (runs once before all tests) ──────────────────────────────────────

before(async () => {
    await Parser.init();
    mdLanguage = await Language.load(MD_WASM);
    parser = new Parser();
    parser.setLanguage(mdLanguage);
    setUniformTokenizer(0.3);
});

// ── computeChunks ───────────────────────────────────────────────────────────

const CHUNK_SINGLE_SECTION_SOURCE = `\
# Overview

This is an overview section with enough text to meet the minimum chunk
size requirement. We need at least 75 characters in the chunk for it to
be retained by the chunking logic. This paragraph provides that.
`;

describe('chunking: single heading section', () => {
    it('should produce at least one chunk', async () => {
        const { chunks } = await chunkFixture(CHUNK_SINGLE_SECTION_SOURCE);
        assert.ok(chunks.length == 1, 'expected one chunk');
    });

    it('chunks should have heading-aware context prefix', async () => {
        const { chunks } = await chunkFixture(CHUNK_SINGLE_SECTION_SOURCE);
        assert.ok(chunks[0].text.includes('file: test.md'),
            'chunk should include file path prefix');
        assert.ok(chunks[0].text.includes('section: Overview'),
            'chunk should include heading section name prefix');
    });

    it('sha256 should be empty at parser level (computed by worker task)', async () => {
        const { chunks } = await chunkFixture(CHUNK_SINGLE_SECTION_SOURCE);
        for (const chunk of chunks) {
            assert.equal(chunk.sha256, '',
                'sha256 should be empty at parser level');
        }
    });

    it('chunk line numbers should be 1-based', async () => {
        const { chunks } = await chunkFixture(CHUNK_SINGLE_SECTION_SOURCE);
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
    it('should produce chunks for each section', async () => {
        const { chunks } = await chunkFixture(CHUNK_MULTIPLE_SECTIONS_SOURCE);
        const ch1Chunk = chunks.find(c => c.text.includes('first chapter'));
        const ch2Chunk = chunks.find(c => c.text.includes('second chapter'));
        assert.ok(ch1Chunk, 'expected a chunk for Chapter 1');
        assert.ok(ch2Chunk, 'expected a chunk for Chapter 2');
        assert.ok(chunks.length == 2, 'expected two chunks');
    });

    it('each section chunk should have the correct heading prefix', async () => {
        const { chunks } = await chunkFixture(CHUNK_MULTIPLE_SECTIONS_SOURCE);
        const ch1Chunk = chunks.find(c => c.text.includes('first chapter'));
        const ch2Chunk = chunks.find(c => c.text.includes('second chapter'));
        assert.ok(ch1Chunk!.text.includes('section: Chapter 1'));
        assert.ok(!ch1Chunk!.text.includes('section: Chapter 2'));
        assert.ok(ch2Chunk!.text.includes('section: Chapter 2'));
        assert.ok(!ch2Chunk!.text.includes('section: Chapter 1'));
    });

    it('each chunk should have correct line numbers', async () => {
        const { chunks } = await chunkFixture(CHUNK_MULTIPLE_SECTIONS_SOURCE);
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
    it('should produce a gap chunk for the intro and a section chunk', async () => {
        const { chunks } = await chunkFixture(CHUNK_CONTENT_BEFORE_HEADING_SOURCE);
        assert.ok(chunks.length == 2, 'expected two chunks');
        const introChunk = chunks.find(c => c.text.includes('introductory'));
        const headingChunk = chunks.find(c => c.text.includes('First Heading'));
        assert.ok(introChunk, 'expected a chunk for intro content');
        assert.ok(headingChunk, 'expected a chunk for heading section');
    });

    it('intro chunk should have file-only prefix (no heading)', async () => {
        const { chunks } = await chunkFixture(CHUNK_CONTENT_BEFORE_HEADING_SOURCE);
        const introChunk = chunks.find(c => c.text.includes('introductory'))!;
        assert.ok(introChunk.text.includes('file: test.md'));
        assert.ok(!introChunk.text.includes('section:'),
            'intro chunk should not have a heading prefix');
    });

    it('each chunk should have correct line numbers', async () => {
        const { chunks } = await chunkFixture(CHUNK_CONTENT_BEFORE_HEADING_SOURCE);
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
    it('H1 intro chunk should have H1-only section prefix', async () => {
        const { chunks } = await chunkFixture(CHUNK_BREADCRUMB_SOURCE);
        assert.ok(chunks.length == 3);
        const introChunk = chunks.find(c => c.text.includes('API overview'));
        assert.ok(introChunk, 'expected a chunk for H1 intro');
        assert.ok(introChunk!.text.includes('section: API Reference'),
            'H1 intro chunk should have H1 name in prefix');
        assert.ok(!introChunk!.text.includes('>'),
            'H1 intro chunk should not have a breadcrumb separator');
    });

    it('H2 chunks should have breadcrumb prefix (H1 > H2)', async () => {
        const { chunks } = await chunkFixture(CHUNK_BREADCRUMB_SOURCE);
        const methodsChunk = chunks.find(c => c.text.includes('Method details'));
        const eventsChunk = chunks.find(c => c.text.includes('Event details'));
        assert.ok(methodsChunk, 'expected a chunk for Methods');
        assert.ok(eventsChunk, 'expected a chunk for Events');
        assert.ok(methodsChunk!.text.includes('section: API Reference > Methods'),
            'Methods chunk should have breadcrumb prefix');
        assert.ok(eventsChunk!.text.includes('section: API Reference > Events'),
            'Events chunk should have breadcrumb prefix');
    });

    it('should produce separate chunks for H1 intro, Methods, and Events', async () => {
        const { chunks } = await chunkFixture(CHUNK_BREADCRUMB_SOURCE);
        const introChunk = chunks.find(c => c.text.includes('API overview'));
        const methodsChunk = chunks.find(c => c.text.includes('Method details'));
        const eventsChunk = chunks.find(c => c.text.includes('Event details'));
        assert.ok(introChunk, 'expected H1 intro chunk');
        assert.ok(methodsChunk, 'expected Methods chunk');
        assert.ok(eventsChunk, 'expected Events chunk');
    });

    it('each chunk should have correct line numbers', async () => {
        const { chunks } = await chunkFixture(CHUNK_BREADCRUMB_SOURCE);
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
    it('should have H2 name only in prefix (no breadcrumb)', async () => {
        const { chunks } = await chunkFixture(CHUNK_STANDALONE_H2_SOURCE);
        assert.ok(chunks.length == 1);
        assert.ok(chunks[0].text.includes('section: Standalone Section'));
        assert.ok(!chunks[0].text.includes('>'),
            'standalone H2 should not have a breadcrumb separator');
    });

    it('chunk should have correct line numbers', async () => {
        const { chunks } = await chunkFixture(CHUNK_STANDALONE_H2_SOURCE);
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
    it('should skip the empty H1 intro and only chunk the H2', async () => {
        const { chunks } = await chunkFixture(CHUNK_EMPTY_H1_BEFORE_H2_SOURCE);
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

    it('chunk should have correct line numbers', async () => {
        const { chunks } = await chunkFixture(CHUNK_EMPTY_H1_BEFORE_H2_SOURCE);
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
    it('should skip the empty H2 and chunk the others', async () => {
        const { chunks } = await chunkFixture(CHUNK_EMPTY_H2_SOURCE);
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

    it('each chunk should have correct line numbers', async () => {
        const { chunks } = await chunkFixture(CHUNK_EMPTY_H2_SOURCE);
        // H1 intro: lines 1..4 (# Overview + body, before ## Empty Section)
        assert.equal(chunks[0].startLine, 1);
        assert.equal(chunks[0].endLine, 4);
        // ## Content Section: lines 8..11
        assert.equal(chunks[1].startLine, 8);
        assert.equal(chunks[1].endLine, 11);
    });
});
