// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Tests for the C/C++ parser ({@link cppParser}).
 *
 * Exercises the full IFileParser contract:
 *   extractSymbols() — CST → raw symbol arrays
 *   hydrateSymbols() — raw symbol arrays → IndexSymbol[]
 *
 * This test can be run from the command line with:
 * npx tsc -p tests/tsconfig.json; node --test out-test/tests/common/index/parsers/cppParser.symbols.test.js
 */

import { describe, it, before } from 'node:test';
import * as assert from 'node:assert/strict';
import { Parser, Language } from 'web-tree-sitter';
import { cppParser } from '../../../../src/common/index/parsers/cpp/cppParser';
import { SymbolType, AttrKey } from '../../../../src/common/index/parsers/types';
import {
    toComparable,
    expectedSymbol,
    filterSymbols,
    debugPrintSyntaxTree,
    setUniformTokenizer,
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

// ── extractSymbols + hydrateSymbols ──────────────────────────────────────────────

const SINGLE_NAMESPACE_SOURCE = `\
// Comment at first line
namespace win {
    int x = 0;
}  // namespace win
`;

describe('single namespace', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(SINGLE_NAMESPACE_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Namespace });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Namespace, 'win', 1, 0, 3, 1, 1, 10, 1, 13, [
            [AttrKey.FullyQualifiedName, 'win'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 14],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const NESTED_NAMESPACE_SOURCE = `\
// Comment at first line
namespace media {
namespace win {
    int x = 0;
}  // namespace win
}  // namespace media
`;

describe('nested namespaces', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(NESTED_NAMESPACE_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Namespace });
        assert.equal(filtered.length, 2);
        const expectedMedia = expectedSymbol(
            SymbolType.Namespace, 'media', 1, 0, 5, 1, 1, 10, 1, 15, [
            [AttrKey.FullyQualifiedName, 'media'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 16],
        ]);
        const expectedWin = expectedSymbol(
            SymbolType.Namespace, 'win', 2, 0, 4, 1, 2, 10, 2, 13, [
            [AttrKey.Scope, 'media'],
            [AttrKey.FullyQualifiedName, 'media::win'],
            [AttrKey.ContainerHeaderEndLine, 2],
            [AttrKey.ContainerHeaderEndColumn, 14],
        ]);
        assert.deepStrictEqual(filtered[0], expectedMedia);
        assert.deepStrictEqual(filtered[1], expectedWin);
    });
});

const ANONYMOUS_NAMESPACE_SOURCE = `\
// Comment at first line
namespace { int secret = 42; }
`;

describe('anonymous namespace', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(ANONYMOUS_NAMESPACE_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Namespace });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Namespace, '(anonymous namespace)', 1, 0, 1, 30, 1, 0, 1, 0, [
            [AttrKey.FullyQualifiedName, '(anonymous namespace)'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 10],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const ANONYMOUS_INSIDE_NAMED_NAMESPACE_SOURCE = `\
// Comment at first line
namespace outer {
    namespace { int secret = 42; }
}  // namespace outer
`;

describe('anonymous namespace inside named namespace', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(ANONYMOUS_INSIDE_NAMED_NAMESPACE_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Namespace });
        assert.equal(filtered.length, 2);
        const expectedOuter = expectedSymbol(
            SymbolType.Namespace, 'outer', 1, 0, 3, 1, 1, 10, 1, 15, [
            [AttrKey.FullyQualifiedName, 'outer'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 16],
        ]);
        const expectedInner = expectedSymbol(
            SymbolType.Namespace, '(anonymous namespace)', 2, 4, 2, 34, 2, 4, 2, 4, [
            [AttrKey.Scope, 'outer'],
            [AttrKey.FullyQualifiedName, 'outer::(anonymous namespace)'],
            [AttrKey.ContainerHeaderEndLine, 2],
            [AttrKey.ContainerHeaderEndColumn, 14],
        ]);
        assert.deepStrictEqual(filtered[0], expectedOuter);
        assert.deepStrictEqual(filtered[1], expectedInner);
    });
});

const EMPTY_NAMESPACE_SOURCE = `\
// Comment at first line
namespace empty { }
`;

describe('empty namespace', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(EMPTY_NAMESPACE_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Namespace });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Namespace, 'empty', 1, 0, 1, 19, 1, 10, 1, 15, [
            [AttrKey.FullyQualifiedName, 'empty'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 16],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const SIBLING_NAMESPACES_SOURCE = `\
// Comment at first line
namespace alpha { int a; }
namespace beta { int b; }
`;

describe('multiple sibling namespaces', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(SIBLING_NAMESPACES_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Namespace });
        assert.equal(filtered.length, 2);
        const expectedAlpha = expectedSymbol(
            SymbolType.Namespace, 'alpha', 1, 0, 1, 26, 1, 10, 1, 15, [
            [AttrKey.FullyQualifiedName, 'alpha'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 16],
        ]);
        const expectedBeta = expectedSymbol(
            SymbolType.Namespace, 'beta', 2, 0, 2, 25, 2, 10, 2, 14, [
            [AttrKey.FullyQualifiedName, 'beta'],
            [AttrKey.ContainerHeaderEndLine, 2],
            [AttrKey.ContainerHeaderEndColumn, 15],
        ]);
        assert.deepStrictEqual(filtered[0], expectedAlpha);
        assert.deepStrictEqual(filtered[1], expectedBeta);
    });
});

// ── Class ───────────────────────────────────────────────────────────────────

const SIMPLE_CLASS_SOURCE = `\
// simple class
class Foo {
  int x;
};
`;

describe('simple class', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(SIMPLE_CLASS_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Class });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Class, 'Foo', 1, 0, 3, 1, 1, 6, 1, 9, [
            [AttrKey.FullyQualifiedName, 'Foo'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 10],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const CLASS_SINGLE_INHERITANCE_SOURCE = `\
// class with inheritance
class Derived : public Base {
  int x;
};
`;

describe('class with single inheritance', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(CLASS_SINGLE_INHERITANCE_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Class });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Class, 'Derived', 1, 0, 3, 1, 1, 6, 1, 13, [
            [AttrKey.FullyQualifiedName, 'Derived'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 28],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const CLASS_MULTIPLE_INHERITANCE_SOURCE = `\
// multiple inheritance
class Foo : public A, public B {
  int x;
};
`;

describe('class with multiple inheritance', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(CLASS_MULTIPLE_INHERITANCE_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Class });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Class, 'Foo', 1, 0, 3, 1, 1, 6, 1, 9, [
            [AttrKey.FullyQualifiedName, 'Foo'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 31],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const FORWARD_DECLARED_CLASS_SOURCE = `\
// forward decl
class Foo;
`;

describe('forward-declared class', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(FORWARD_DECLARED_CLASS_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Class });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Class, 'Foo', 1, 0, 1, 9, 1, 6, 1, 9, [
            [AttrKey.FullyQualifiedName, 'Foo'],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const CLASS_INSIDE_NAMESPACE_SOURCE = `\
// class in ns
namespace ns {
class Foo {
  int x;
};
}
`;

describe('class inside namespace', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(CLASS_INSIDE_NAMESPACE_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Class });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Class, 'Foo', 2, 0, 4, 1, 2, 6, 2, 9, [
            [AttrKey.Scope, 'ns'],
            [AttrKey.FullyQualifiedName, 'ns::Foo'],
            [AttrKey.ContainerHeaderEndLine, 2],
            [AttrKey.ContainerHeaderEndColumn, 10],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const NESTED_CLASS_SOURCE = `\
// nested class
class Outer {
class Inner {
  int x;
};
};
`;

describe('nested class', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(NESTED_CLASS_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Class });
        assert.equal(filtered.length, 2);
        const expectedOuter = expectedSymbol(
            SymbolType.Class, 'Outer', 1, 0, 5, 1, 1, 6, 1, 11, [
            [AttrKey.FullyQualifiedName, 'Outer'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 12],
        ]);
        const expectedInner = expectedSymbol(
            SymbolType.Class, 'Inner', 2, 0, 4, 1, 2, 6, 2, 11, [
            [AttrKey.Scope, 'Outer'],
            [AttrKey.FullyQualifiedName, 'Outer::Inner'],
            [AttrKey.ContainerHeaderEndLine, 2],
            [AttrKey.ContainerHeaderEndColumn, 12],
        ]);
        assert.deepStrictEqual(filtered[0], expectedOuter);
        assert.deepStrictEqual(filtered[1], expectedInner);
    });
});

const TEMPLATE_CLASS_SOURCE = `\
// template class
template<typename T>
class Foo {
  T val;
};
`;

describe('template class', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(TEMPLATE_CLASS_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Class });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Class, 'Foo', 2, 0, 4, 1, 2, 6, 2, 9, [
            [AttrKey.FullyQualifiedName, 'Foo'],
            [AttrKey.ContainerHeaderEndLine, 2],
            [AttrKey.ContainerHeaderEndColumn, 10],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

// ── Struct ──────────────────────────────────────────────────────────────────

const SIMPLE_STRUCT_SOURCE = `\
// simple struct
struct Point {
  int x;
  int y;
};
`;

describe('simple struct', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(SIMPLE_STRUCT_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Struct });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Struct, 'Point', 1, 0, 4, 1, 1, 7, 1, 12, [
            [AttrKey.FullyQualifiedName, 'Point'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 13],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const STRUCT_INSIDE_NAMESPACE_SOURCE = `\
// struct in ns
namespace ns {
struct Point {
  int x;
};
}
`;

describe('struct inside namespace', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(STRUCT_INSIDE_NAMESPACE_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Struct });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Struct, 'Point', 2, 0, 4, 1, 2, 7, 2, 12, [
            [AttrKey.Scope, 'ns'],
            [AttrKey.FullyQualifiedName, 'ns::Point'],
            [AttrKey.ContainerHeaderEndLine, 2],
            [AttrKey.ContainerHeaderEndColumn, 13],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const ANONYMOUS_STRUCT_SOURCE = `\
// anon struct
struct {
  int x;
} instance;
`;

describe('anonymous struct', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(ANONYMOUS_STRUCT_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Struct });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Struct, '', 1, 0, 3, 1, 1, 0, 1, 0, [
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 7],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

// ── Union ───────────────────────────────────────────────────────────────────

const SIMPLE_UNION_SOURCE = `\
// union
union Data {
  int i;
  float f;
};
`;

describe('simple union', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(SIMPLE_UNION_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Union });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Union, 'Data', 1, 0, 4, 1, 1, 6, 1, 10, [
            [AttrKey.FullyQualifiedName, 'Data'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 11],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

// ── Enum ────────────────────────────────────────────────────────────────────

const SIMPLE_ENUM_SOURCE = `\
// simple enum
enum Color { Red, Green, Blue };
`;

describe('simple enum', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(SIMPLE_ENUM_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Enum });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Enum, 'Color', 1, 0, 1, 31, 1, 5, 1, 10, [
            [AttrKey.FullyQualifiedName, 'Color'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 11],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const SCOPED_ENUM_SOURCE = `\
// enum class
enum class Color { Red, Green, Blue };
`;

describe('scoped enum (enum class)', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(SCOPED_ENUM_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Enum });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Enum, 'Color', 1, 0, 1, 37, 1, 11, 1, 16, [
            [AttrKey.FullyQualifiedName, 'Color'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 17],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

// ── Function ────────────────────────────────────────────────────────────────

const SIMPLE_FREE_FUNCTION_SOURCE = `\
// simple free function
int add(int a, int b) { return a + b; }
`;

describe('simple free function', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(SIMPLE_FREE_FUNCTION_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Function });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Function, 'add', 1, 0, 1, 39, 1, 4, 1, 7, [
            [AttrKey.FullyQualifiedName, 'add'],
            [AttrKey.Signature, 'int add(int a, int b)'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 22],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const FUNCTION_RETURNING_POINTER_SOURCE = `\
// function returning pointer
int* foo(int x) { return nullptr; }
`;

describe('function returning pointer', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(FUNCTION_RETURNING_POINTER_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Function });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Function, 'foo', 1, 0, 1, 35, 1, 5, 1, 8, [
            [AttrKey.FullyQualifiedName, 'foo'],
            [AttrKey.Signature, 'int* foo(int x)'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 16],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const FUNCTION_RETURNING_REFERENCE_SOURCE = `\
// function returning reference
int& foo(int x) { return x; }
`;

describe('function returning reference', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(FUNCTION_RETURNING_REFERENCE_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Function });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Function, 'foo', 1, 0, 1, 29, 1, 5, 1, 8, [
            [AttrKey.FullyQualifiedName, 'foo'],
            [AttrKey.Signature, 'int& foo(int x)'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 16],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const TRAILING_RETURN_TYPE_SOURCE = `\
// trailing return type
auto foo(int x) -> int { return x; }
`;

describe('trailing return type', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(TRAILING_RETURN_TYPE_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Function });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Function, 'foo', 1, 0, 1, 36, 1, 5, 1, 8, [
            [AttrKey.FullyQualifiedName, 'foo'],
            [AttrKey.Signature, 'auto foo(int x) -> int'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 23],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const VOID_FUNCTION_NO_PARAMS_SOURCE = `\
// void function no params
void bar() { }
`;

describe('void function no params', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(VOID_FUNCTION_NO_PARAMS_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Function });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Function, 'bar', 1, 0, 1, 14, 1, 5, 1, 8, [
            [AttrKey.FullyQualifiedName, 'bar'],
            [AttrKey.Signature, 'void bar()'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 11],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const GTEST_STYLE_FUNCTION = `\
// gtest style function
TEST_F(TestClass, TestName) {
    int x = 0;
}
`;

// GTest-style macros (TEST_F, TEST, TEST_P, etc.) are parsed by tree-sitter
// as function_definition nodes with no return type.
describe('gtest style function', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(GTEST_STYLE_FUNCTION);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Function });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Function, 'TEST_F', 1, 0, 3, 1, 1, 0, 1, 6, [
            [AttrKey.FullyQualifiedName, 'TEST_F'],
            [AttrKey.Signature, 'TEST_F(TestClass, TestName)'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 28],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const OPERATOR_EQ_EQ_FUNCTION = `\
// operator== style function
bool operator==(const dict& lhs, const dict& rhs) {
  return lhs.dict == rhs.dict;
}
`;

// GTest-style macros (TEST_F, TEST, TEST_P, etc.) are parsed by tree-sitter
// as function_definition nodes with no return type.
describe('operator== style function', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(OPERATOR_EQ_EQ_FUNCTION);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Function });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Function, 'operator==', 1, 0, 3, 1, 1, 5, 1, 15, [
            [AttrKey.FullyQualifiedName, 'operator=='],
            [AttrKey.Signature, 'bool operator==(const dict& lhs, const dict& rhs)'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 50],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const MULTIPLE_HEADER_FUNCTION = `\
// multiple header function
#if BUILDFLAG(ENABLE_FEATURE)
void bar()
#else
void bar(int x)
#endif
{
}
`;

// When #if/#else/#endif wraps the function signature, tree-sitter cannot
// produce a function_definition node.  It parses each branch as a separate
// declaration inside a preproc_if, and the body { } becomes an orphaned
// compound_statement.  No Function symbol is emitted — this is a
// fundamental tree-sitter limitation (it doesn't run the preprocessor).
describe('multiple header function (preprocessor limitation)', () => {
    it('should produce zero Function symbols', () => {
        const { symbols } = parseFixture(MULTIPLE_HEADER_FUNCTION);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Function });
        assert.equal(filtered.length, 0);
    });
});

const FUNCTION_WITH_PREPROC_CONDITIONAL_INSIDE = `\
// function with preproc conditional inside
bool test() const {
#if BUILDFLAG(ENABLE)
  return true
#else
  return false;
#endif
}
`;

describe('function with preproc conditional inside', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(FUNCTION_WITH_PREPROC_CONDITIONAL_INSIDE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Function });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Function, 'test', 1, 0, 7, 1, 1, 5, 1, 9, [
            [AttrKey.FullyQualifiedName, 'test'],
            [AttrKey.Signature, 'bool test() const'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 18],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

// ── Method ──────────────────────────────────────────────────────────────────

const INLINE_METHOD_SOURCE = `\
// inline method in class
class Player { int getVolume() { return 0; } };
`;

describe('inline method in class', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(INLINE_METHOD_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Method });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Method, 'getVolume', 1, 15, 1, 44, 1, 19, 1, 28, [
            [AttrKey.Scope, 'Player'],
            [AttrKey.FullyQualifiedName, 'Player::getVolume'],
            [AttrKey.Signature, 'int getVolume()'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 31],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const VIRTUAL_METHOD_SOURCE = `\
// virtual method in class
class Base { virtual void tick() { } };
`;

describe('virtual method in class', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(VIRTUAL_METHOD_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Method });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Method, 'tick', 1, 13, 1, 36, 1, 26, 1, 30, [
            [AttrKey.Scope, 'Base'],
            [AttrKey.FullyQualifiedName, 'Base::tick'],
            [AttrKey.Signature, 'virtual void tick()'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 33],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const CONST_NOEXCEPT_METHOD_SOURCE = `\
// const noexcept method
class Foo { void bar() const noexcept { } };
`;

describe('const noexcept method', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(CONST_NOEXCEPT_METHOD_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Method });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Method, 'bar', 1, 12, 1, 41, 1, 17, 1, 20, [
            [AttrKey.Scope, 'Foo'],
            [AttrKey.FullyQualifiedName, 'Foo::bar'],
            [AttrKey.Signature, 'void bar() const noexcept'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 38],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const STATIC_METHOD_SOURCE = `\
// static method
class Counter { static int count() { return 0; } };
`;

describe('static method in class', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(STATIC_METHOD_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Method });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Method, 'count', 1, 16, 1, 48, 1, 27, 1, 32, [
            [AttrKey.Scope, 'Counter'],
            [AttrKey.FullyQualifiedName, 'Counter::count'],
            [AttrKey.Signature, 'static int count()'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 35],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

// ── Constructor ─────────────────────────────────────────────────────────────

const CONSTRUCTOR_IN_CLASS_SOURCE = `\
// constructor in class
class MyClass { MyClass() { } };
`;

describe('constructor in class', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(CONSTRUCTOR_IN_CLASS_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Constructor });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Constructor, 'MyClass', 1, 16, 1, 29, 1, 16, 1, 23, [
            [AttrKey.Scope, 'MyClass'],
            [AttrKey.FullyQualifiedName, 'MyClass::MyClass'],
            [AttrKey.Signature, 'MyClass()'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 26],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

// ── Destructor ──────────────────────────────────────────────────────────────

const DESTRUCTOR_IN_CLASS_SOURCE = `\
// destructor in class
class MyClass { ~MyClass() { } };
`;

describe('destructor in class', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(DESTRUCTOR_IN_CLASS_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Destructor });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Destructor, '~MyClass', 1, 16, 1, 30, 1, 16, 1, 24, [
            [AttrKey.Scope, 'MyClass'],
            [AttrKey.FullyQualifiedName, 'MyClass::~MyClass'],
            [AttrKey.Signature, '~MyClass()'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 27],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const EXPLICIT_CONSTRUCTOR_SOURCE = `\
// explicit constructor with params
class Svc { explicit Svc(bool f, int id) { } };
`;

describe('explicit constructor with params', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(EXPLICIT_CONSTRUCTOR_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Constructor });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Constructor, 'Svc', 1, 12, 1, 44, 1, 21, 1, 24, [
            [AttrKey.Scope, 'Svc'],
            [AttrKey.FullyQualifiedName, 'Svc::Svc'],
            [AttrKey.Signature, 'explicit Svc(bool f, int id)'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 41],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

// ── Out-of-line definitions ─────────────────────────────────────────────────

const OUT_OF_LINE_METHOD_SOURCE = `\
// out-of-line method
void Player::play() { }
`;

describe('out-of-line method definition', () => {
    it('should classify as Function (not Method) at file scope', () => {
        const { symbols } = parseFixture(OUT_OF_LINE_METHOD_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Function });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Function, 'play', 1, 0, 1, 23, 1, 13, 1, 17, [
            [AttrKey.Scope, 'Player'],
            [AttrKey.FullyQualifiedName, 'Player::play'],
            [AttrKey.Signature, 'void Player::play()'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 20],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const OUT_OF_LINE_CONSTRUCTOR_SOURCE = `\
// out-of-line constructor
Player::Player() { }
`;

describe('out-of-line constructor', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(OUT_OF_LINE_CONSTRUCTOR_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Constructor });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Constructor, 'Player', 1, 0, 1, 20, 1, 8, 1, 14, [
            [AttrKey.Scope, 'Player'],
            [AttrKey.FullyQualifiedName, 'Player::Player'],
            [AttrKey.Signature, 'Player::Player()'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 17],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const OUT_OF_LINE_DESTRUCTOR_SOURCE = `\
// out-of-line destructor
Player::~Player() { }
`;

describe('out-of-line destructor', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(OUT_OF_LINE_DESTRUCTOR_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Destructor });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Destructor, '~Player', 1, 0, 1, 21, 1, 8, 1, 15, [
            [AttrKey.Scope, 'Player'],
            [AttrKey.FullyQualifiedName, 'Player::~Player'],
            [AttrKey.Signature, 'Player::~Player()'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 18],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const OUT_OF_LINE_METHOD_WITH_TEMPLATE_ARG = `\
namespace ns {
// out-of-line method with template argument
void TestClass::TestMethod(
    const std::string& key,
    base::OnceCallback<void(Service::StatusCallback)> task) {
    int x = 0;
}
}
`;

describe('out-of-line method with template argument', () => {
    it('should classify as Function with correct scope and FQN', () => {
        const { symbols } = parseFixture(OUT_OF_LINE_METHOD_WITH_TEMPLATE_ARG);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Function });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Function, 'TestMethod', 2, 0, 6, 1, 2, 16, 2, 26, [
            [AttrKey.Scope, 'ns::TestClass'],
            [AttrKey.FullyQualifiedName, 'ns::TestClass::TestMethod'],
            [AttrKey.Signature, 'void TestClass::TestMethod(const std::string& key, base::OnceCallback<void(Service::StatusCallback)> task)'],
            [AttrKey.ContainerHeaderEndLine, 4],
            [AttrKey.ContainerHeaderEndColumn, 60],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const OUT_OF_LINE_METHOD_WITH_RETURN_TYPE_ON_PREVIOUS_LINE = `\
namespace ns {
// out-of-line method with template argument
 std::string&
TestClass::TestMethod(
    const std::string& key,
    base::OnceCallback<void(Service::StatusCallback)> task) {
    int x = 0;
    return "test";
}
}
`;

describe('out-of-line method with return type on previous line', () => {
    it('should classify as Function with correct scope and FQN', () => {
        const { symbols } = parseFixture(OUT_OF_LINE_METHOD_WITH_RETURN_TYPE_ON_PREVIOUS_LINE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Function });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Function, 'TestMethod', 2, 1, 8, 1, 3, 11, 3, 21, [
            [AttrKey.Scope, 'ns::TestClass'],
            [AttrKey.FullyQualifiedName, 'ns::TestClass::TestMethod'],
            [AttrKey.Signature, 'std::string& TestClass::TestMethod(const std::string& key, base::OnceCallback<void(Service::StatusCallback)> task)'],
            [AttrKey.ContainerHeaderEndLine, 5],
            [AttrKey.ContainerHeaderEndColumn, 60],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const OUT_OF_LINE_METHOD_WITH_LAMBDA_SOURCE = `\
namespace ns {
// method containing a lambda
void TestClass::TestMethod() {
    auto cb = [](int x) { return x + 1; };
    int y = cb(5);
}
}
`;

describe('out-of-line method containing a lambda', () => {
    it('should not capture the lambda as a separate symbol', () => {
        const { symbols } = parseFixture(OUT_OF_LINE_METHOD_WITH_LAMBDA_SOURCE);
        const actual = symbols.map(toComparable);
        // The outer function should be captured
        const funcs = filterSymbols(actual, { type: SymbolType.Function });
        assert.equal(funcs.length, 1);
        const expected = expectedSymbol(
            SymbolType.Function, 'TestMethod', 2, 0, 5, 1, 2, 16, 2, 26, [
            [AttrKey.Scope, 'ns::TestClass'],
            [AttrKey.FullyQualifiedName, 'ns::TestClass::TestMethod'],
            [AttrKey.Signature, 'void TestClass::TestMethod()'],
            [AttrKey.ContainerHeaderEndLine, 2],
            [AttrKey.ContainerHeaderEndColumn, 29],
        ]);
        assert.deepStrictEqual(funcs[0], expected);
        // Lambdas are not captured — tree-sitter uses lambda_expression
        // which is not in the query patterns
        const methods = filterSymbols(actual, { type: SymbolType.Method });
        assert.equal(methods.length, 0);
        const ctors = filterSymbols(actual, { type: SymbolType.Constructor });
        assert.equal(ctors.length, 0);
    });
});



// ── Function in namespace ───────────────────────────────────────────────────

const FUNCTION_IN_NAMESPACE_SOURCE = `\
// function in namespace
namespace ns { int foo() { return 0; } }
`;

describe('function in namespace', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(FUNCTION_IN_NAMESPACE_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Function });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Function, 'foo', 1, 15, 1, 38, 1, 19, 1, 22, [
            [AttrKey.Scope, 'ns'],
            [AttrKey.FullyQualifiedName, 'ns::foo'],
            [AttrKey.Signature, 'int foo()'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 25],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

// ── Method with multiple params ─────────────────────────────────────────────

const METHOD_WITH_MULTIPLE_PARAMS_SOURCE = `\
// method with multiple params
class Obj { int setPos(int x, int y, int z) { return 0; } };
`;

describe('method with multiple params', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(METHOD_WITH_MULTIPLE_PARAMS_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Method });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Method, 'setPos', 1, 12, 1, 57, 1, 16, 1, 22, [
            [AttrKey.Scope, 'Obj'],
            [AttrKey.FullyQualifiedName, 'Obj::setPos'],
            [AttrKey.Signature, 'int setPos(int x, int y, int z)'],
            [AttrKey.ContainerHeaderEndLine, 1],
            [AttrKey.ContainerHeaderEndColumn, 44],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

// ── Prototype symbols ───────────────────────────────────────────────────────

const SIMPLE_FORWARD_DECLARATION_SOURCE = `\
// simple forward declaration
void foo(int x);
`;

describe('simple forward declaration', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(SIMPLE_FORWARD_DECLARATION_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Prototype });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Prototype, 'foo', 1, 0, 1, 16, 1, 5, 1, 8, [
            [AttrKey.FullyQualifiedName, 'foo'],
            [AttrKey.Signature, 'void foo(int x)'],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const METHOD_DECLARATION_IN_CLASS_SOURCE = `\
// method declaration in class
class Foo { void play(); };
`;

describe('method declaration in class', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(METHOD_DECLARATION_IN_CLASS_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Prototype });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Prototype, 'play', 1, 12, 1, 24, 1, 17, 1, 21, [
            [AttrKey.Scope, 'Foo'],
            [AttrKey.FullyQualifiedName, 'Foo::play'],
            [AttrKey.Signature, 'void play()'],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const VIRTUAL_METHOD_DECLARATION_SOURCE = `\
// virtual method declaration
class Foo { virtual void update(); };
`;

describe('virtual method declaration', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(VIRTUAL_METHOD_DECLARATION_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Prototype });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Prototype, 'update', 1, 12, 1, 34, 1, 25, 1, 31, [
            [AttrKey.Scope, 'Foo'],
            [AttrKey.FullyQualifiedName, 'Foo::update'],
            [AttrKey.Signature, 'virtual void update()'],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const PURE_VIRTUAL_METHOD_SOURCE = `\
// pure virtual method
class Foo { virtual void update() = 0; };
`;

describe('pure virtual method', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(PURE_VIRTUAL_METHOD_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Prototype });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Prototype, 'update', 1, 12, 1, 38, 1, 25, 1, 31, [
            [AttrKey.Scope, 'Foo'],
            [AttrKey.FullyQualifiedName, 'Foo::update'],
            [AttrKey.Signature, 'virtual void update()'],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const CONST_METHOD_DECLARATION_SOURCE = `\
// const method declaration
class Foo { int getValue() const; };
`;

describe('const method declaration', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(CONST_METHOD_DECLARATION_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Prototype });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Prototype, 'getValue', 1, 12, 1, 33, 1, 16, 1, 24, [
            [AttrKey.Scope, 'Foo'],
            [AttrKey.FullyQualifiedName, 'Foo::getValue'],
            [AttrKey.Signature, 'int getValue() const'],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const STATIC_METHOD_DECLARATION_SOURCE = `\
// static method declaration
class Foo { static void create(); };
`;

describe('static method declaration', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(STATIC_METHOD_DECLARATION_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Prototype });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Prototype, 'create', 1, 12, 1, 33, 1, 24, 1, 30, [
            [AttrKey.Scope, 'Foo'],
            [AttrKey.FullyQualifiedName, 'Foo::create'],
            [AttrKey.Signature, 'static void create()'],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const PROTOTYPE_IN_NAMESPACE_SOURCE = `\
// prototype inside namespace
namespace ns { void doWork(int a); }
`;

describe('prototype inside namespace', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(PROTOTYPE_IN_NAMESPACE_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Prototype });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Prototype, 'doWork', 1, 15, 1, 34, 1, 20, 1, 26, [
            [AttrKey.Scope, 'ns'],
            [AttrKey.FullyQualifiedName, 'ns::doWork'],
            [AttrKey.Signature, 'void doWork(int a)'],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const NOEXCEPT_METHOD_DECLARATION_SOURCE = `\
// noexcept method declaration
class Foo { void swap(Foo& other) noexcept; };
`;

describe('noexcept method declaration', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(NOEXCEPT_METHOD_DECLARATION_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Prototype });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Prototype, 'swap', 1, 12, 1, 43, 1, 17, 1, 21, [
            [AttrKey.Scope, 'Foo'],
            [AttrKey.FullyQualifiedName, 'Foo::swap'],
            [AttrKey.Signature, 'void swap(Foo& other) noexcept'],
        ]);
        assert.deepStrictEqual(filtered[0], expected);
    });
});

// Pointer-return forward declarations are captured as Prototype via
// the (pointer_declarator (function_declarator)) query pattern.
const POINTER_RETURN_FORWARD_DECLARATION_SOURCE = `\
// pointer return forward declaration
int* bar(int x);
`;

describe('pointer return forward declaration', () => {
    it('should produce one Prototype symbol', () => {
        const { symbols } = parseFixture(POINTER_RETURN_FORWARD_DECLARATION_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Prototype });
        assert.equal(filtered.length, 1);
        assert.equal(filtered[0].name, 'bar');
        const sig = filtered[0].attrs.find(
            ([k]) => k === AttrKey.Signature);
        assert.ok(sig);
        assert.equal(sig![1], 'int* bar(int x)');
        const fqn = filtered[0].attrs.find(
            ([k]) => k === AttrKey.FullyQualifiedName);
        assert.ok(fqn);
        assert.equal(fqn![1], 'bar');
    });
});

// Reference-return forward declarations are captured as Prototype via
// the (reference_declarator (function_declarator)) query pattern.
const REFERENCE_RETURN_FORWARD_DECLARATION_SOURCE = `\
// reference return forward declaration
int& baz(int x);
`;

describe('reference return forward declaration', () => {
    it('should produce one Prototype symbol', () => {
        const { symbols } = parseFixture(REFERENCE_RETURN_FORWARD_DECLARATION_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Prototype });
        assert.equal(filtered.length, 1);
        assert.equal(filtered[0].name, 'baz');
        const sig = filtered[0].attrs.find(
            ([k]) => k === AttrKey.Signature);
        assert.ok(sig);
        assert.equal(sig![1], 'int& baz(int x)');
        const fqn = filtered[0].attrs.find(
            ([k]) => k === AttrKey.FullyQualifiedName);
        assert.ok(fqn);
        assert.equal(fqn![1], 'baz');
    });
});

// Pointer-return method declaration inside a class body.
const POINTER_RETURN_METHOD_DECL_SOURCE = `\
// pointer return method decl
class Foo {
    int* create(int n);
};
`;

describe('pointer return method declaration in class', () => {
    it('should produce one Prototype symbol with class scope', () => {
        const { symbols } = parseFixture(POINTER_RETURN_METHOD_DECL_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Prototype });
        assert.equal(filtered.length, 1);
        assert.equal(filtered[0].name, 'create');
        const scope = filtered[0].attrs.find(
            ([k]) => k === AttrKey.Scope);
        assert.ok(scope);
        assert.equal(scope![1], 'Foo');
        const fqn = filtered[0].attrs.find(
            ([k]) => k === AttrKey.FullyQualifiedName);
        assert.ok(fqn);
        assert.equal(fqn![1], 'Foo::create');
        const sig = filtered[0].attrs.find(
            ([k]) => k === AttrKey.Signature);
        assert.ok(sig);
        assert.equal(sig![1], 'int* create(int n)');
    });
});

// Reference-return method declaration inside a class body.
const REFERENCE_RETURN_METHOD_DECL_SOURCE = `\
// reference return method decl
class Foo {
    int& getRef();
};
`;

describe('reference return method declaration in class', () => {
    it('should produce one Prototype symbol with class scope', () => {
        const { symbols } = parseFixture(REFERENCE_RETURN_METHOD_DECL_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Prototype });
        assert.equal(filtered.length, 1);
        assert.equal(filtered[0].name, 'getRef');
        const scope = filtered[0].attrs.find(
            ([k]) => k === AttrKey.Scope);
        assert.ok(scope);
        assert.equal(scope![1], 'Foo');
        const fqn = filtered[0].attrs.find(
            ([k]) => k === AttrKey.FullyQualifiedName);
        assert.ok(fqn);
        assert.equal(fqn![1], 'Foo::getRef');
        const sig = filtered[0].attrs.find(
            ([k]) => k === AttrKey.Signature);
        assert.ok(sig);
        assert.equal(sig![1], 'int& getRef()');
    });
});

// `= delete` is parsed as `function_definition` by tree-sitter, NOT as a
// prototype.  The deleted copy constructor becomes a Constructor symbol.
const DELETED_COPY_CONSTRUCTOR_SOURCE = `\
// deleted copy constructor
class Foo { Foo(const Foo&) = delete; };
`;

describe('deleted copy constructor is not a prototype', () => {
    it('should produce zero Prototype symbols and one Constructor', () => {
        const { symbols } = parseFixture(DELETED_COPY_CONSTRUCTOR_SOURCE);
        const actual = symbols.map(toComparable);
        const protos = filterSymbols(actual, { type: SymbolType.Prototype });
        assert.equal(protos.length, 0);
        const ctors = filterSymbols(actual, { type: SymbolType.Constructor });
        assert.equal(ctors.length, 1);
    });
});

// `= default` is parsed as `function_definition` by tree-sitter, NOT as a
// prototype.  The defaulted constructor becomes a Constructor symbol.
const DEFAULTED_CONSTRUCTOR_SOURCE = `\
// defaulted constructor
class Foo { Foo() = default; };
`;

describe('defaulted constructor is not a prototype', () => {
    it('should produce zero Prototype symbols and one Constructor', () => {
        const { symbols } = parseFixture(DEFAULTED_CONSTRUCTOR_SOURCE);
        const actual = symbols.map(toComparable);
        const protos = filterSymbols(actual, { type: SymbolType.Prototype });
        assert.equal(protos.length, 0);
        const ctors = filterSymbols(actual, { type: SymbolType.Constructor });
        assert.equal(ctors.length, 1);
        const expected = expectedSymbol(
            SymbolType.Constructor, 'Foo', 1, 12, 1, 28, 1, 12, 1, 15, [
            [AttrKey.Scope, 'Foo'],
            [AttrKey.FullyQualifiedName, 'Foo::Foo'],
            [AttrKey.Signature, 'Foo()'],
        ]);
        assert.deepStrictEqual(ctors[0], expected);
    });
});

// ── SourceInclude ───────────────────────────────────────────────────────────

const ANGLE_BRACKET_INCLUDE_SOURCE = `\
// first line
#include <header.h>
`;

describe('angle-bracket include', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(ANGLE_BRACKET_INCLUDE_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.SourceInclude });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.SourceInclude, '', 1, 0, 1, 19, 1, 9, 1, 19,
        );
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const QUOTED_INCLUDE_SOURCE = `\
// first line
#include "local.h"
`;

describe('quoted include', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(QUOTED_INCLUDE_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.SourceInclude });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.SourceInclude, '', 1, 0, 1, 18, 1, 9, 1, 18,
        );
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const MULTIPLE_INCLUDES_SOURCE = `\
// first line
#include <a.h>
#include <b.h>
#include <c.h>
`;

describe('multiple includes', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(MULTIPLE_INCLUDES_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.SourceInclude });
        assert.equal(filtered.length, 3);
        const expectedA = expectedSymbol(
            SymbolType.SourceInclude, '', 1, 0, 1, 14, 1, 9, 1, 14,
        );
        const expectedB = expectedSymbol(
            SymbolType.SourceInclude, '', 2, 0, 2, 14, 2, 9, 2, 14,
        );
        const expectedC = expectedSymbol(
            SymbolType.SourceInclude, '', 3, 0, 3, 14, 3, 9, 3, 14,
        );
        assert.deepStrictEqual(filtered[0], expectedA);
        assert.deepStrictEqual(filtered[1], expectedB);
        assert.deepStrictEqual(filtered[2], expectedC);
    });
});

// ── CodeComment ─────────────────────────────────────────────────────────────

const SINGLE_LINE_COMMENT_SOURCE = `\
// single line comment
int x = 0;
`;

describe('single-line comment', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(SINGLE_LINE_COMMENT_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.CodeComment });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.CodeComment, '', 0, 0, 0, 22, 0, 0, 0, 0,
        );
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const MULTIPLE_CONSECUTIVE_SINGLE_LINE_COMMENT_SOURCE = `\
// single line comment
// another single line comment
int x = 0; // comment 1
int y = 0; // comment 2
`;

describe('multiple consecutive single-line comment', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(MULTIPLE_CONSECUTIVE_SINGLE_LINE_COMMENT_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.CodeComment });
        assert.equal(filtered.length, 3);
        const expected1 = expectedSymbol(
            SymbolType.CodeComment, '', 0, 0, 1, 30, 0, 0, 0, 0,
        );
        const expected2 = expectedSymbol(
            SymbolType.CodeComment, '', 2, 11, 2, 23, 2, 11, 2, 11,
        );
        const expected3 = expectedSymbol(
            SymbolType.CodeComment, '', 3, 11, 3, 23, 3, 11, 3, 11,
        );
        assert.deepStrictEqual(filtered[0], expected1);
        assert.deepStrictEqual(filtered[1], expected2);
        assert.deepStrictEqual(filtered[2], expected3);
    });
});

const MULTI_LINE_BLOCK_COMMENT_SOURCE = `\
// first line
/* block
   comment */
`;

describe('multi-line block comment', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(MULTI_LINE_BLOCK_COMMENT_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.CodeComment });
        assert.equal(filtered.length, 2);
        const expectedLine = expectedSymbol(
            SymbolType.CodeComment, '', 0, 0, 0, 13, 0, 0, 0, 0,
        );
        const expectedBlock = expectedSymbol(
            SymbolType.CodeComment, '', 1, 0, 2, 13, 1, 0, 1, 0,
        );
        assert.deepStrictEqual(filtered[0], expectedLine);
        assert.deepStrictEqual(filtered[1], expectedBlock);
    });
});

// ── Macro ───────────────────────────────────────────────────────────────────

const SIMPLE_MACRO_SOURCE = `\
// first line
#define FOO 1
`;

describe('simple macro', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(SIMPLE_MACRO_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Macro });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Macro, 'FOO', 1, 0, 1, 13, 1, 8, 1, 11,
        );
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const MULTI_LINE_MACRO_SOURCE = `\
// first line
#define FOO \\
    42
`;

describe('multi-line macro with backslash continuation', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(MULTI_LINE_MACRO_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Macro });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Macro, 'FOO', 1, 0, 2, 6, 1, 8, 1, 11,
        );
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const INCLUDE_GUARD_MACRO_SOURCE = `\
// first line
#define GUARD_H_
`;

describe('include guard macro', () => {
    it('should produce the exact expected symbols', () => {
        const { symbols } = parseFixture(INCLUDE_GUARD_MACRO_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Macro });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Macro, 'GUARD_H_', 1, 0, 1, 16, 1, 8, 1, 16,
        );
        assert.deepStrictEqual(filtered[0], expected);
    });
});

// Function-like macros (#define with parameters) are parsed by tree-sitter
// as `preproc_function_def`. The query captures them via the @func_macro pattern.
const FUNCTION_LIKE_MACRO_SOURCE = `\
// first line
#define MAX(a, b) ((a) > (b) ? (a) : (b))
`;

describe('function-like macro', () => {
    it('should produce one Macro symbol with correct name', () => {
        const { symbols } = parseFixture(FUNCTION_LIKE_MACRO_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Macro });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Macro, 'MAX', 1, 0, 1, 41, 1, 8, 1, 11,
        );
        assert.deepStrictEqual(filtered[0], expected);
    });
});

const FUNCTION_LIKE_MACRO_MULTI_LINE_SOURCE = `\
// first line
#define MAX(a, b) \\
    ((a) > (b) ? (a) : (b))
`;

describe('function-like macro multi-line', () => {
    it('should produce one Macro symbol spanning multiple lines', () => {
        const { symbols } = parseFixture(FUNCTION_LIKE_MACRO_MULTI_LINE_SOURCE);
        const actual = symbols.map(toComparable);
        const filtered = filterSymbols(actual, { type: SymbolType.Macro });
        assert.equal(filtered.length, 1);
        const expected = expectedSymbol(
            SymbolType.Macro, 'MAX', 1, 0, 2, 27, 1, 8, 1, 11,
        );
        assert.deepStrictEqual(filtered[0], expected);
    });
});
