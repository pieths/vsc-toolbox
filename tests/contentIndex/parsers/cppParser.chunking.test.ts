// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Tests for the C/C++ parser ({@link cppParser}).
 *
 * Exercises the full IFileParser contract:
 *   computeChunks()  — source lines + symbols → Chunk[]
 *
 * This test can be run from the command line with:
 * npx tsc -p tests/tsconfig.json; node --test out-test/tests/contentIndex/parsers/cppParser.chunking.test.js
 */

import { describe, it, before } from 'node:test';
import * as assert from 'node:assert/strict';
import { Parser, Language } from 'web-tree-sitter';
import { cppParser } from '../../../src/contentIndex/parsers/cpp/cppParser';
import {
    debugPrintSyntaxTree,
    setUniformTokenizer,
    makeChunkingConfig,
    getWasmPath,
} from './parserTestUtils';

// ── Paths ───────────────────────────────────────────────────────────────────

/** WASM grammar for C++ */
const CPP_WASM = getWasmPath('cpp.wasm');

// ── Shared state ────────────────────────────────────────────────────────────

let parser: InstanceType<typeof Parser>;
let cppLanguage: Language;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse a source string through the full extractSymbols → hydrateSymbols pipeline.
 * Returns everything needed for assertions.
 */
function parseFixture(source: string, filePath: string = 'test.cpp', debug: boolean = false) {
    const tree = parser.parse(source);
    assert.ok(tree, `tree-sitter failed to parse ${filePath}`);
    const rawSymbols = cppParser.extractSymbols(tree.rootNode, filePath);
    const symbols = cppParser.hydrateSymbols(rawSymbols);
    const lines = source.split('\n');
    if (debug) {
        console.log(debugPrintSyntaxTree(tree.rootNode));
    }
    return { filePath, source, lines, rawSymbols, symbols };
}

// ── Setup (runs once before all tests) ──────────────────────────────────────

before(async () => {
    await Parser.init();
    cppLanguage = await Language.load(CPP_WASM);
    parser = new Parser();
    parser.setLanguage(cppLanguage);
    setUniformTokenizer(0.3);
});

// ── Chunking (computeChunks) ────────────────────────────────────────────────

/**
 * Default chunking config matching the production budgets passed to
 * the parser by {@link CacheManager}.
 */
const CHUNKING_CONFIG = makeChunkingConfig(2046, 3584);

/**
 * Helper: parse source through the full pipeline and return chunks.
 */
async function chunkFixture(source: string, filePath: string = 'test.cpp') {
    const { lines, symbols } = parseFixture(source, filePath);
    const chunks = await cppParser.computeChunks(lines, symbols, filePath, CHUNKING_CONFIG);
    return { chunks, lines, symbols };
}

// -- Preamble skipping -------------------------------------------------------

const CHUNK_PREAMBLE_SKIP_SOURCE = `\
// Copyright 2024 The Authors
// Use of this source code is governed by a BSD-style license.

#include <stddef.h>

#include <string>
#include <vector>

#include "base/base_switches.h"
#include "base/files/file_path.h"

void func() {
    int x = 0;
    int y = 1;
    int z = 2;
    int w = 3;
    int a = 4;
}
`;

describe('chunking: preamble skipping', () => {
    it('should skip copyright and includes, start chunking at content', async () => {
        const { chunks } = await chunkFixture(CHUNK_PREAMBLE_SKIP_SOURCE);
        assert.ok(chunks.length == 1, 'There should be exactly one chunk');
        const chunk = chunks[0];
        // Chunk should not contain the copyright line
        assert.ok(!chunk.text.includes('Copyright 2024'),
            'chunk should not contain copyright header');
        // Chunk should not contain #include directives
        assert.ok(!chunk.text.includes('#include'),
            'chunk should not contain #include directives');
        // The function content should be present
        const hasFunc = chunks.some(c => c.text.includes('void func()'));
        assert.ok(hasFunc, 'expected function content in chunks');
        assert.equal(chunk.startLine, 12);
        assert.equal(chunk.endLine, 18);
    });
});

const CHUNK_NO_INCLUDES_SOURCE = `\
// Copyright notice Copyright notice Copyright notice Copyright notice
// License header License header License header License header License header

void doWork() {
    int x = 1;
    int y = 2;
    int z = 3;
    int w = 4;
    int a = 5;
}
`;

describe('chunking: no includes in file', () => {
    it('should start from line 0 when there are no includes', async () => {
        const { chunks } = await chunkFixture(CHUNK_NO_INCLUDES_SOURCE);
        // With no includes, preamble end is 0, so the copyright comment
        // could appear in a chunk. In this case the copyright header is too
        // small and should not be included (removed via boilerPlate check).
        assert.ok(chunks.length == 1, 'expected at least one chunk');
        const chunk = chunks[0];
        const hasFunc = chunk.text.includes('void doWork()');
        assert.ok(hasFunc, 'expected function content in chunks');
        assert.equal(chunk.startLine, 4);
        assert.equal(chunk.endLine, 10);
    });
});

const CHUNK_ONLY_INCLUDES_SOURCE = `\
// Copyright notice

#include <string>
#include <vector>
#include <map>
`;

describe('chunking: file with only includes', () => {
    it('should produce no chunks when file is all preamble', async () => {
        const { chunks } = await chunkFixture(CHUNK_ONLY_INCLUDES_SOURCE);
        // After skipping the preamble, there's nothing left to chunk
        assert.equal(chunks.length, 0, 'expected no chunks for includes-only file');
    });
});

// -- Context prefix -----------------------------------------------------------

const CHUNK_FUNCTION_PREFIX_SOURCE = `\
#include <string>

void myFunction(int param) {
    int x = 0;
    int y = 1;
    int z = 2;
    int w = 3;
    int a = 4;
    int b = 5;
}
`;

describe('chunking: function context prefix', () => {
    it('should include file and Function prefix in chunk text', async () => {
        const { chunks } = await chunkFixture(CHUNK_FUNCTION_PREFIX_SOURCE, 'src/foo.cpp');
        assert.ok(chunks.length >= 1, 'expected at least one chunk');
        const funcChunk = chunks.find(c => c.text.includes('void myFunction'));
        assert.ok(funcChunk, 'expected a chunk containing the function');
        assert.ok(funcChunk!.text.includes('// file: src/foo.cpp'),
            'chunk should include file prefix');
        assert.ok(funcChunk!.text.includes('// Function: myFunction'),
            'chunk should include Function kind prefix');
        assert.equal(funcChunk!.startLine, 3);
        assert.equal(funcChunk!.endLine, 10);
    });
});

const CHUNK_CLASS_PREFIX_SOURCE = `\
#include <string>

class MyClass {
    int x;
    int y;
    void method() {}
    void method2() {}
    void method3() {}
};
`;

describe('chunking: class context prefix', () => {
    it('should include Class prefix in chunk text', async () => {
        const { chunks } = await chunkFixture(CHUNK_CLASS_PREFIX_SOURCE, 'src/bar.cpp');
        assert.ok(chunks.length == 1, 'expected one chunk');
        const classChunk = chunks.find(c => c.text.includes('class MyClass'));
        assert.ok(classChunk, 'expected a chunk containing the class');
        assert.ok(classChunk!.text.includes('// file: src/bar.cpp'),
            'chunk should include file prefix');
        assert.ok(classChunk!.text.includes('// Class: MyClass'),
            'chunk should include Class kind prefix');
        assert.equal(classChunk!.startLine, 3);
        assert.equal(classChunk!.endLine, 9);
    });
});

const CHUNK_STRUCT_PREFIX_SOURCE = `\
#include <string>

struct MyPoint {
    int x;
    int y;
    int z;
    void normalize() {}
};
`;

describe('chunking: struct context prefix', () => {
    it('should include Struct prefix in chunk text', async () => {
        const { chunks } = await chunkFixture(CHUNK_STRUCT_PREFIX_SOURCE, 'src/point.h');
        assert.ok(chunks.length == 1);
        const structChunk = chunks.find(c => c.text.includes('struct MyPoint'));
        assert.ok(structChunk, 'expected a chunk containing the struct');
        assert.ok(structChunk!.text.includes('// Struct: MyPoint'),
            'chunk should include Struct kind prefix');
        assert.equal(structChunk!.startLine, 3);
        assert.equal(structChunk!.endLine, 8);
    });
});

const CHUNK_ENUM_PREFIX_SOURCE = `\
#include <string>

enum class Direction {
    North,
    South,
    East,
    West,
    Up,
    Down,
};
`;

describe('chunking: enum context prefix', () => {
    it('should include Enum prefix in chunk text', async () => {
        const { chunks } = await chunkFixture(CHUNK_ENUM_PREFIX_SOURCE, 'src/dir.h');
        assert.ok(chunks.length == 1);
        const enumChunk = chunks.find(c => c.text.includes('enum class Direction'));
        assert.ok(enumChunk, 'expected a chunk containing the enum');
        assert.ok(enumChunk!.text.includes('// Enum: Direction'),
            'chunk should include Enum kind prefix');
        assert.equal(enumChunk!.startLine, 3);
        assert.equal(enumChunk!.endLine, 10);
    });
});

// -- Namespace exclusion from chunking containers ----------------------------

const CHUNK_NAMESPACE_EXCLUSION_SOURCE = `\
#include <string>

namespace media {

void play() {
    int x = 1;
    int y = 2;
    int z = 3;
    int w = 4;
}

void stop() {
    int a = 1;
    int b = 2;
    int c = 3;
    int d = 4;
}

}  // namespace media
`;

describe('chunking: namespace does not wrap entire file', () => {
    it('should produce separate chunks for functions, not one big namespace chunk', async () => {
        const { chunks } = await chunkFixture(CHUNK_NAMESPACE_EXCLUSION_SOURCE);
        assert.ok(chunks.length == 2, 'expected two chunks (one per function)');
        // Should have Function prefixes, not a Namespace prefix
        const hasNamespacePrefix = chunks.some(c => c.text.includes('// Namespace:'));
        assert.ok(!hasNamespacePrefix,
            'no chunk should have a Namespace prefix (namespaces are excluded from chunking)');
        const playChunk = chunks.find(c => c.text.includes('void play()'));
        const stopChunk = chunks.find(c => c.text.includes('void stop()'));
        assert.ok(playChunk, 'expected a chunk for play()');
        assert.ok(stopChunk, 'expected a chunk for stop()');

        assert.equal(playChunk!.startLine, 5);
        assert.equal(playChunk!.endLine, 10);

        assert.equal(stopChunk!.startLine, 12);
        assert.equal(stopChunk!.endLine, 17);
    });
});

// -- Scoped function prefix (FQN) --------------------------------------------

const CHUNK_SCOPED_FQN_SOURCE = `\
#include <string>

namespace media {
namespace win {

void Player::play() {
    int x = 1;
    int y = 2;
    int z = 3;
    int w = 4;
}

}  // namespace win
}  // namespace media
`;

describe('chunking: scoped FQN in prefix', () => {
    it('should use the fully qualified name in the context prefix', async () => {
        const { chunks } = await chunkFixture(CHUNK_SCOPED_FQN_SOURCE);
        assert.ok(chunks.length == 1);
        const playChunk = chunks.find(c => c.text.includes('void Player::play()'));
        assert.ok(playChunk, 'expected a chunk for Player::play()');
        assert.ok(playChunk!.text.includes('// Function: media::win::Player::play'),
            'chunk should include fully qualified name in prefix');
        assert.equal(playChunk!.startLine, 6);
        assert.equal(playChunk!.endLine, 11);
    });
});

// -- Gap chunking (content between containers) --------------------------------

const CHUNK_GAP_CONTENT_SOURCE = `\
#include <string>

// Forward declarations
void foo();
void bar();
int baz(int x);
int qux(int y);
void quux();

class MyClass {
    int x;
    int y;
    void method() {}
    void method2() {}
    void method3() {}
};
`;

describe('chunking: gap content between preamble and container', () => {
    it('should produce a gap chunk for forward declarations', async () => {
        const { chunks } = await chunkFixture(CHUNK_GAP_CONTENT_SOURCE);
        assert.ok(chunks.length == 2);
        // The forward declarations appear between the includes and the class.
        // They should be in a gap chunk with a file-only prefix (no container prefix).
        const gapChunk = chunks.find(c =>
            c.text.includes('void foo()') && !c.text.includes('class MyClass'));
        assert.ok(gapChunk, 'expected a gap chunk with forward declarations');
        assert.ok(gapChunk!.text.includes('// file:'),
            'gap chunk should have file prefix');
        assert.ok(!gapChunk!.text.includes('// Class:'),
            'gap chunk should not have a container prefix');

        assert.equal(gapChunk!.startLine, 3);
        assert.equal(gapChunk!.endLine, 8);
    });
});

// -- Trailing content ---------------------------------------------------------

const CHUNK_TRAILING_CONTENT_SOURCE = `\
#include <string>

void firstFunc() {
    int x = 1;
    int y = 2;
    int z = 3;
}

// Trailing utility macros and constants
static const int kMaxSize = 100;
static const int kMinSize = 10;
static const int kDefaultSize = 50;
static const char* kName = "test";
static const char* kVersion = "1.0";
static const char* kAuthor = "anonymous";
`;

describe('chunking: trailing content after last container', () => {
    it('should produce chunks for content after the last function', async () => {
        const { chunks } = await chunkFixture(CHUNK_TRAILING_CONTENT_SOURCE);
        assert.ok(chunks.length >= 1);
        const trailingChunk = chunks.find(c => c.text.includes('kMaxSize'));
        assert.ok(trailingChunk, 'expected a chunk containing trailing constants');

        assert.equal(trailingChunk!.startLine, 9);
        assert.equal(trailingChunk!.endLine, 15);
    });
});

// -- Boilerplate filtering ----------------------------------------------------

const CHUNK_BOILERPLATE_SOURCE = `\
#include <string>

}  // namespace old

#endif  // GUARD_H_
`;

describe('chunking: boilerplate-only content is filtered', () => {
    it('should produce no chunks when remaining content is pure boilerplate', async () => {
        const { chunks } = await chunkFixture(CHUNK_BOILERPLATE_SOURCE);
        // After skipping the include, only closing brace + #endif remain,
        // which are boilerplate. Short boilerplate is filtered out.
        assert.equal(chunks.length, 0, 'expected no chunks for boilerplate-only content');
    });
});

// -- Chunk line numbers (1-based, inclusive) -----------------------------------

const CHUNK_LINE_NUMBERS_SOURCE = `\
#include <string>

void func() {
    int x = 0;
    int y = 1;
    int z = 2;
    int w = 3;
    int a = 4;
}
`;

describe('chunking: line numbers are 1-based inclusive', () => {
    it('should have startLine >= 1 and endLine >= startLine', async () => {
        const { chunks } = await chunkFixture(CHUNK_LINE_NUMBERS_SOURCE);
        assert.ok(chunks.length >= 1);
        for (const chunk of chunks) {
            assert.ok(chunk.startLine >= 1,
                `startLine should be >= 1, got ${chunk.startLine}`);
            assert.ok(chunk.endLine >= chunk.startLine,
                `endLine (${chunk.endLine}) should be >= startLine (${chunk.startLine})`);
        }

        const chunk = chunks[0];
        assert.equal(chunk.startLine, 3);
        assert.equal(chunk.endLine, 9);
    });
});

// -- Chunk SHA-256 digest -----------------------------------------------------

describe('chunking: SHA-256 digest', () => {
    it('sha256 should be empty at parser level (computed by worker task)', async () => {
        const { chunks } = await chunkFixture(CHUNK_LINE_NUMBERS_SOURCE);
        assert.ok(chunks.length >= 1);
        for (const chunk of chunks) {
            assert.equal(chunk.sha256, '',
                'sha256 should be empty at parser level');
        }
    });
});

// -- Multiple functions produce separate chunks --------------------------------

const CHUNK_MULTIPLE_FUNCTIONS_SOURCE = `\
#include <string>

void alpha() {
    int a1 = 1;
    int a2 = 2;
    int a3 = 3;
    int a4 = 4;
    int a5 = 5;
}

void beta() {
    int b1 = 1;
    int b2 = 2;
    int b3 = 3;
    int b4 = 4;
    int b5 = 5;
}

void gamma() {
    int g1 = 1;
    int g2 = 2;
    int g3 = 3;
    int g4 = 4;
    int g5 = 5;
}
`;

describe('chunking: multiple functions get separate chunks', () => {
    it('should produce at least one chunk per function', async () => {
        const { chunks } = await chunkFixture(CHUNK_MULTIPLE_FUNCTIONS_SOURCE);
        const alphaChunk = chunks.find(c => c.text.includes('void alpha()'));
        const betaChunk = chunks.find(c => c.text.includes('void beta()'));
        const gammaChunk = chunks.find(c => c.text.includes('void gamma()'));
        assert.ok(alphaChunk, 'expected a chunk for alpha()');
        assert.ok(betaChunk, 'expected a chunk for beta()');
        assert.ok(gammaChunk, 'expected a chunk for gamma()');
    });

    it('each function chunk should have its own FQN prefix', async () => {
        const { chunks } = await chunkFixture(CHUNK_MULTIPLE_FUNCTIONS_SOURCE);
        const alphaChunk = chunks.find(c => c.text.includes('void alpha()'));
        const betaChunk = chunks.find(c => c.text.includes('void beta()'));
        const gammaChunk = chunks.find(c => c.text.includes('void gamma()'));
        assert.ok(alphaChunk!.text.includes('// Function: alpha'));
        assert.ok(betaChunk!.text.includes('// Function: beta'));
        assert.ok(gammaChunk!.text.includes('// Function: gamma'));
    });

    it('each function chunk should have the correct line numbers', async () => {
        const { chunks } = await chunkFixture(CHUNK_MULTIPLE_FUNCTIONS_SOURCE);
        const alphaChunk = chunks.find(c => c.text.includes('void alpha()'));
        const betaChunk = chunks.find(c => c.text.includes('void beta()'));
        const gammaChunk = chunks.find(c => c.text.includes('void gamma()'));

        assert.equal(alphaChunk!.startLine, 3);
        assert.equal(alphaChunk!.endLine, 9);
        assert.equal(betaChunk!.startLine, 11);
        assert.equal(betaChunk!.endLine, 17);
        assert.equal(gammaChunk!.startLine, 19);
        assert.equal(gammaChunk!.endLine, 25);
    });
});

// -- Doc comment absorbed into container chunk --------------------------------

const CHUNK_DOC_COMMENT_ABSORBED_SOURCE = `\
#include <string>

// This is a documentation comment
// describing what doWork does in detail.
void doWork(int param) {
    int x = param + 1;
    int y = param + 2;
    int z = param + 3;
    int w = param + 4;
}
`;

describe('chunking: doc comment absorbed into container', () => {
    it('should include the preceding comment in the function chunk', async () => {
        const { chunks } = await chunkFixture(CHUNK_DOC_COMMENT_ABSORBED_SOURCE);
        assert.ok(chunks.length >= 1);
        const funcChunk = chunks.find(c => c.text.includes('void doWork'));
        assert.ok(funcChunk, 'expected a chunk for doWork()');
        // expandRangesToIncludePrecedingLines should absorb the doc comment
        assert.ok(funcChunk!.text.includes('documentation comment'),
            'function chunk should include the preceding doc comment');

        const chunk = chunks[0];
        assert.equal(chunk.startLine, 3);
        assert.equal(chunk.endLine, 10);
    });
});

// -- Header file with include guard -------------------------------------------

const CHUNK_HEADER_GUARD_SOURCE = `\
// Copyright notice

#ifndef MY_HEADER_H_
#define MY_HEADER_H_

#include <string>
#include <vector>

class Widget {
    int width;
    int height;
    void render() {}
    void resize() {}
    void update() {}
};

#endif  // MY_HEADER_H_
`;

describe('chunking: header with include guard', () => {
    it('should skip the include guard and includes', async () => {
        const { chunks } = await chunkFixture(CHUNK_HEADER_GUARD_SOURCE, 'widget.h');
        assert.ok(chunks.length == 1);
        // No chunk should contain the include guard
        for (const chunk of chunks) {
            assert.ok(!chunk.text.includes('#ifndef MY_HEADER_H_'),
                'chunk should not contain #ifndef guard');
            assert.ok(!chunk.text.includes('#define MY_HEADER_H_'),
                'chunk should not contain #define guard');
            assert.ok(!chunk.text.includes('#include'),
                'chunk should not contain #include');
        }
        // The class should be chunked
        const classChunk = chunks.find(c => c.text.includes('class Widget'));
        assert.ok(classChunk, 'expected a chunk for Widget class');

        assert.equal(classChunk!.startLine, 9);
        assert.equal(classChunk!.endLine, 15);
    });
});

// -- Header file with #pragma once --------------------------------------------

const CHUNK_PRAGMA_ONCE_SOURCE = `\
// Copyright notice

#pragma once

#include <memory>
#include <string>

struct Config {
    int timeout;
    int retries;
    bool verbose;
    std::string name;
    std::string host;
};
`;

describe('chunking: header with #pragma once', () => {
    it('should skip pragma once and includes', async () => {
        const { chunks } = await chunkFixture(CHUNK_PRAGMA_ONCE_SOURCE, 'config.h');
        assert.ok(chunks.length == 1);
        for (const chunk of chunks) {
            assert.ok(!chunk.text.includes('#pragma once'),
                'chunk should not contain #pragma once');
            assert.ok(!chunk.text.includes('#include'),
                'chunk should not contain #include');
        }
        const structChunk = chunks.find(c => c.text.includes('struct Config'));
        assert.ok(structChunk, 'expected a chunk for Config struct');

        assert.equal(structChunk!.startLine, 8);
        assert.equal(structChunk!.endLine, 14);
    });
});

// -- Constructor and destructor chunking --------------------------------------

const CHUNK_CTOR_DTOR_SOURCE = `\
#include <string>

class Player {
    int volume_;
public:
    Player() : volume_(0) {}
    ~Player() {}
    void play() {}
    void stop() {}
    int getVolume() const { return volume_; }
};
`;

describe('chunking: class with constructor and destructor', () => {
    it('should include constructor and destructor in class chunk', async () => {
        const { chunks } = await chunkFixture(CHUNK_CTOR_DTOR_SOURCE);
        assert.ok(chunks.length == 1);
        const classChunk = chunks.find(c => c.text.includes('class Player'));
        assert.ok(classChunk, 'expected a chunk for Player class');
        assert.ok(classChunk!.text.includes('Player()'),
            'class chunk should include constructor');
        assert.ok(classChunk!.text.includes('~Player()'),
            'class chunk should include destructor');

        assert.equal(classChunk!.startLine, 3);
        assert.equal(classChunk!.endLine, 11);
    });
});

// -- Out-of-line definitions as separate chunks --------------------------------

const CHUNK_OUT_OF_LINE_SOURCE = `\
#include "player.h"

Player::Player() : volume_(0) {
    int init1 = 0;
    int init2 = 0;
    int init3 = 0;
}

Player::~Player() {
    int cleanup1 = 0;
    int cleanup2 = 0;
    int cleanup3 = 0;
}

void Player::play() {
    int step1 = 0;
    int step2 = 0;
    int step3 = 0;
}
`;

describe('chunking: out-of-line definitions', () => {
    it('should produce separate chunks for each out-of-line definition', async () => {
        const { chunks } = await chunkFixture(CHUNK_OUT_OF_LINE_SOURCE);
        assert.ok(chunks.length >= 3, 'expected at least 3 chunks');
        const ctorChunk = chunks.find(c => c.text.includes('Player::Player()'));
        const dtorChunk = chunks.find(c => c.text.includes('Player::~Player()'));
        const playChunk = chunks.find(c => c.text.includes('Player::play()'));
        assert.ok(ctorChunk, 'expected a chunk for constructor');
        assert.ok(dtorChunk, 'expected a chunk for destructor');
        assert.ok(playChunk, 'expected a chunk for play()');
    });

    it('should have correct kind prefixes for out-of-line definitions', async () => {
        const { chunks } = await chunkFixture(CHUNK_OUT_OF_LINE_SOURCE);
        const ctorChunk = chunks.find(c => c.text.includes('Player::Player()'));
        const dtorChunk = chunks.find(c => c.text.includes('Player::~Player()'));
        const playChunk = chunks.find(c => c.text.includes('Player::play()'));
        assert.ok(ctorChunk!.text.includes('// Constructor:'),
            'constructor chunk should have Constructor prefix');
        assert.ok(dtorChunk!.text.includes('// Destructor:'),
            'destructor chunk should have Destructor prefix');
        assert.ok(playChunk!.text.includes('// Function:'),
            'play chunk should have Function prefix');
    });

    it('should produce correct line numbers', async () => {
        const { chunks } = await chunkFixture(CHUNK_OUT_OF_LINE_SOURCE);
        assert.ok(chunks.length == 3, 'expected at least 3 chunks');
        const ctorChunk = chunks[0];
        const dtorChunk = chunks[1];
        const playChunk = chunks[2];

        assert.equal(ctorChunk.startLine, 3);
        assert.equal(ctorChunk.endLine, 7);
        assert.equal(dtorChunk.startLine, 9);
        assert.equal(dtorChunk.endLine, 13);
        assert.equal(playChunk.startLine, 15);
        assert.equal(playChunk.endLine, 19);
    });
});

// -- Empty file ---------------------------------------------------------------

describe('chunking: empty file', () => {
    it('should produce no chunks', async () => {
        const chunks = await cppParser.computeChunks([], [], 'empty.cpp', CHUNKING_CONFIG);
        assert.deepStrictEqual(chunks, []);
    });
});

// -- File with only a comment -------------------------------------------------

const CHUNK_ONLY_COMMENT_SOURCE = `\
// This file is intentionally left blank.
`;

describe('chunking: file with only a comment', () => {
    it('should produce no chunks (comment is too short / boilerplate)', async () => {
        const { chunks } = await chunkFixture(CHUNK_ONLY_COMMENT_SOURCE);
        // A single short comment line is below MIN_CHUNK_CHARS (75)
        assert.equal(chunks.length, 0);
    });
});

// -- Chunks do not overlap container boundaries --------------------------------

const CHUNK_NO_OVERLAP_SOURCE = `\
#include <string>

void first() {
    int x1 = 1;
    int x2 = 2;
    int x3 = 3;
    int x4 = 4;
    int x5 = 5;
    int x6 = 6;
}

void second() {
    int y1 = 1;
    int y2 = 2;
    int y3 = 3;
    int y4 = 4;
    int y5 = 5;
    int y6 = 6;
}
`;

describe('chunking: chunks respect container boundaries', () => {
    it('should not mix content from different containers', async () => {
        const { chunks } = await chunkFixture(CHUNK_NO_OVERLAP_SOURCE);
        // Find the chunk containing first() and verify it doesn't contain second()
        const firstChunk = chunks.find(c =>
            c.text.includes('void first()') && c.text.includes('x1'));
        assert.ok(firstChunk, 'expected a chunk for first()');
        assert.ok(!firstChunk!.text.includes('void second()'),
            'first() chunk should not contain second()');

        assert.ok(chunks.length == 2, 'expected at 2 chunks');

        assert.equal(chunks[0].startLine, 3);
        assert.equal(chunks[0].endLine, 10);

        assert.equal(chunks[1].startLine, 12);
        assert.equal(chunks[1].endLine, 19);
    });
});

// -- Signature prefix on non-first chunks of large functions ------------------

const CHUNK_SIGNATURE_PREFIX_SOURCE = (() => {
    // Build a function large enough to span multiple chunks (> MAX_CHUNK_CHARS)
    const lines = ['#include <string>', ''];
    lines.push('void largeFunction(int param1, int param2) {');
    for (let i = 0; i < 200; i++) {
        lines.push(`    int var_${i} = ${i};`);
    }
    lines.push('}');
    lines.push('');
    return lines.join('\n');
})();

describe('chunking: signature prefix on continuation chunks', () => {
    it('should add signature prefix on non-first chunks of a large function', async () => {
        const { chunks } = await chunkFixture(CHUNK_SIGNATURE_PREFIX_SOURCE);
        assert.ok(chunks.length >= 2,
            `expected at least 2 chunks for a function exceeding MAX_CHUNK_CHARS, got ${chunks.length}`);
        // First chunk should have the Function prefix but no signature prefix
        const firstChunk = chunks[0];
        assert.ok(firstChunk.text.includes('// Function: largeFunction'),
            'first chunk should have Function prefix');
        assert.ok(!firstChunk.text.includes('// signature:'),
            'first chunk should NOT have a signature prefix');
        // Second chunk should include a signature prefix
        const secondChunk = chunks[1];
        assert.ok(secondChunk.text.includes('// signature: void largeFunction(int param1, int param2)'),
            'continuation chunk should include a signature prefix');

        // First chunk starts at the function (line 3, after #include + blank)
        assert.equal(chunks[0].startLine, 3);
        // Last chunk ends at the closing brace (line 204: 2 preamble + 1 decl + 200 body + 1 brace)
        assert.equal(chunks[chunks.length - 1].endLine, 204);
    });
});

// -- Union chunking -----------------------------------------------------------

const CHUNK_UNION_SOURCE = `\
#include <string>

union Variant {
    int intVal;
    float floatVal;
    double doubleVal;
    char charVal;
    long longVal;
};
`;

describe('chunking: union', () => {
    it('should produce a chunk with Union prefix', async () => {
        const { chunks } = await chunkFixture(CHUNK_UNION_SOURCE);
        assert.ok(chunks.length == 1);
        const unionChunk = chunks.find(c => c.text.includes('union Variant'));
        assert.ok(unionChunk, 'expected a chunk for union Variant');
        assert.ok(unionChunk!.text.includes('// Union: Variant'),
            'chunk should include Union kind prefix');

        assert.equal(chunks[0].startLine, 3);
        assert.equal(chunks[0].endLine, 9);
    });
});

// -- Mixed containers in one file ---------------------------------------------

const CHUNK_MIXED_CONTAINERS_SOURCE = `\
#include <string>
#include <vector>

enum class Color {
    Red,
    Green,
    Blue,
    Alpha,
    White,
    Black,
    Yellow,
    Cyan,
};

struct Point {
    int x;
    int y;
    int z;
    int w;
    double magnitude;
};

class Shape {
    Point origin;
    Color color;
public:
    void draw() {}
    void move() {}
    void resize() {}
    void rotate() {}
};

void freeFunction() {
    int local1 = 1;
    int local2 = 2;
    int local3 = 3;
    int local4 = 4;
    int local5 = 5;
}
`;

describe('chunking: mixed containers in one file', () => {
    it('should produce chunks for each container type', async () => {
        const { chunks } = await chunkFixture(CHUNK_MIXED_CONTAINERS_SOURCE);
        const enumChunk = chunks.find(c => c.text.includes('enum class Color'));
        const structChunk = chunks.find(c => c.text.includes('struct Point'));
        const classChunk = chunks.find(c => c.text.includes('class Shape'));
        const funcChunk = chunks.find(c => c.text.includes('void freeFunction()'));
        assert.ok(enumChunk, 'expected a chunk for Color enum');
        assert.ok(structChunk, 'expected a chunk for Point struct');
        assert.ok(classChunk, 'expected a chunk for Shape class');
        assert.ok(funcChunk, 'expected a chunk for freeFunction');

        assert.equal(enumChunk!.startLine, 4);
        assert.equal(enumChunk!.endLine, 13);
        assert.equal(structChunk!.startLine, 15);
        assert.equal(structChunk!.endLine, 21);
        assert.equal(classChunk!.startLine, 23);
        assert.equal(classChunk!.endLine, 31);
        assert.equal(funcChunk!.startLine, 33);
        assert.equal(funcChunk!.endLine, 39);
    });

    it('each container chunk should have the correct kind prefix', async () => {
        const { chunks } = await chunkFixture(CHUNK_MIXED_CONTAINERS_SOURCE);
        const enumChunk = chunks.find(c => c.text.includes('enum class Color'));
        const structChunk = chunks.find(c => c.text.includes('struct Point'));
        const classChunk = chunks.find(c => c.text.includes('class Shape'));
        const funcChunk = chunks.find(c => c.text.includes('void freeFunction()'));
        assert.ok(enumChunk!.text.includes('// Enum: Color'));
        assert.ok(structChunk!.text.includes('// Struct: Point'));
        assert.ok(classChunk!.text.includes('// Class: Shape'));
        assert.ok(funcChunk!.text.includes('// Function: freeFunction'));
    });
});

// -- Interleaved includes do not appear in chunks -----------------------------

const CHUNK_INTERLEAVED_INCLUDES_SOURCE = `\
// Copyright

#include <string>

// Forward declaration section
void helper();
void process();
void validate();
void transform();
void serialize();

#include <vector>

class Engine {
    int rpm;
    int temp;
    void start() {}
    void stop() {}
    void accelerate() {}
};
`;

describe('chunking: includes after gap content', () => {
    it('should skip all includes regardless of position', async () => {
        const { chunks } = await chunkFixture(CHUNK_INTERLEAVED_INCLUDES_SOURCE);
        assert.ok(chunks.length == 1);
        // The preamble ends after the LAST include (#include <vector> at line 11).
        // So the forward declarations between the two includes are skipped too.
        for (const chunk of chunks) {
            assert.ok(!chunk.text.includes('#include'),
                'no chunk should contain an #include directive');
        }

        assert.equal(chunks[0].startLine, 14);
        assert.equal(chunks[0].endLine, 20);
    });
});
