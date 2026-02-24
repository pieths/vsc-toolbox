// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Core types for the parser subsystem.
 *
 * Every type here is free of `vscode` imports so that parsers can run
 * in worker threads (indexing, chunking) as well as in the extension host.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Chunk } from '../types';

export type { Chunk };

// ── SymbolType ──────────────────────────────────────────────────────────────

/**
 * Numeric type tag for indexed symbols.
 * Stored as the first value in each symbol's numeric sub-array (index 0).
 *
 * IMPORTANT: Values are persisted in *.idx files on disk.
 * Never reorder or reuse a retired value — only append.
 * Groups are spaced by 20 so new entries can be inserted without
 * renumbering the entire enum.
 */
export const enum SymbolType {
    // ── Structural ────────────────────────────
    Namespace = 1,   // namespace, module, etc.
    Class = 2,
    Struct = 3,
    Union = 4,
    Enum = 5,

    // ── Callable ──────────────────────────────
    Function = 20,
    Method = 21,
    Constructor = 22,
    Destructor = 23,
    Prototype = 24,  // forward declaration

    // ── Directives / Imports ──────────────────
    SourceInclude = 40, // C/C++ #include

    // ── Misc ──────────────────────────────────
    CodeComment = 60,
    Macro = 61,
}

// ── AttrKey ─────────────────────────────────────────────────────────────────

/**
 * Keys for type-dependent attributes in {@link IndexSymbol.attrs}.
 *
 * IMPORTANT: Values are used as Map keys in memory.
 * Never reorder or reuse a retired value — only append.
 *
 * Why a const enum instead of string keys?
 *  - Type safety — `attrs.get(AttrKey.Scope)` catches typos at compile time.
 *  - Discoverability — autocomplete shows all valid keys.
 *  - Refactorability — renaming a key is a single rename-symbol operation.
 *  - Zero runtime cost — the enum is erased by the compiler.
 */
export const enum AttrKey {
    /** Scope / containing context (e.g. "media::win") */
    Scope = 1,
    /** Fully qualified name (e.g. "media::win::myMethod") */
    FullyQualifiedName = 2,
    /** Full function/method signature (e.g. "void myMethod(int a, int b)") */
    Signature = 3,
    /** Container header end line (0-based) */
    ContainerHeaderEndLine = 4,
    /** Container header end column (0-based exclusive) */
    ContainerHeaderEndColumn = 5,
}

// ── AttrMap ─────────────────────────────────────────────────────────────────

/**
 * Maps each {@link AttrKey} to the TypeScript type of its value.
 */
export interface AttrTypeMap {
    [AttrKey.Scope]: string;
    [AttrKey.FullyQualifiedName]: string;
    [AttrKey.Signature]: string;
    [AttrKey.ContainerHeaderEndLine]: number;
    [AttrKey.ContainerHeaderEndColumn]: number;
}

/**
 * A {@link ReadonlyMap} with a narrowed `get()` that returns the correct
 * value type for each {@link AttrKey}.  Purely compile-time — at runtime
 * this is a plain `Map`. This is a convenience interface so that call
 * sites don't have to use `as string` or `as number` when retrieving attributes.
 */
export interface AttrMap extends ReadonlyMap<AttrKey, AttrTypeMap[AttrKey]> {
    get<K extends AttrKey>(key: K): AttrTypeMap[K] | undefined;
}

/** Union of all possible attr value types — derived from {@link AttrTypeMap}. */
export type AttrValue = AttrTypeMap[AttrKey];

/**
 * Mutable map used by parsers to construct symbol attributes.
 * Extends {@link AttrMap} with a type-safe `set()` that enforces the
 * correct value type for each {@link AttrKey} at compile time.
 */
export interface MutableAttrMap extends AttrMap {
    set<K extends AttrKey>(key: K, value: AttrTypeMap[K]): this;
}

// ── IndexFile ───────────────────────────────────────────────────────────────

/**
 * On-disk representation of an `*.idx` file.
 *
 * Positional tuple: `[sha256, version, filePath, symbols]`
 *   - `[0]` sha256   — hex digest of the **source file** at index time;
 *                       used for staleness checks.
 *   - `[1]` version  — the parser's {@link IFileParser.formatVersion} at
 *                       write time. Readers compare against the current
 *                       parser's version to detect incompatible files.
 *   - `[2]` filePath — absolute path to the source file that was indexed.
 *   - `[3]` symbols  — array of symbol arrays produced by `parseCst()`.
 *                       Layout of each inner array is parser-private.
 */
export type IndexFile = [sha256: string, version: number, filePath: string, symbols: unknown[][]];

// ── IndexSymbol ─────────────────────────────────────────────────────────────

/**
 * Hydrated in-memory representation of a symbol, produced by
 * {@link IFileParser.readIndex}. This is the type that `FileIndex`
 * query methods operate on (replacing the current `Tag` interface).
 *
 * Every instance has exactly the same 11 properties (uniform V8
 * hidden class). Type-dependent data lives in the `attrs` Map.
 *
 * Positions follow VS Code conventions: all values are 0-based.
 * The start position (startLine, startColumn) is inclusive;
 * the end position (endLine, endColumn) is exclusive — it points to
 * the character just after the last character of the symbol.
 * For a single-line symbol on line 0, both startLine and endLine are 0.
 * The positions are similar to the vscode.DocumentSymbol class `range`
 * and `selectionRange` though they might differ in some aspects depending
 * on the type of the symbol.
 */
export interface IndexSymbol {
    /** Symbol type tag */
    readonly type: SymbolType;
    /** Symbol name (e.g. "myMethod") */
    readonly name: string;

    /** Full extent of the symbol node in the source file (0-based, end-exclusive). */
    readonly startLine: number;
    readonly startColumn: number;
    readonly endLine: number;
    readonly endColumn: number;

    /** Position of the symbol's name/identifier in the source file (0-based, end-exclusive). */
    readonly nameStartLine: number;
    readonly nameStartColumn: number;
    readonly nameEndLine: number;
    readonly nameEndColumn: number;

    /** Type-dependent attributes (may be empty, never undefined) */
    readonly attrs: AttrMap;
}

// ── IFileParser ─────────────────────────────────────────────────────────────

/**
 * Contract that every language parser must implement.
 *
 * - `parseCst()`      runs in worker threads (no vscode dependency).
 * - `readIndex()`     runs in the extension host to hydrate `*.idx` files.
 * - `computeChunks()` runs in worker threads (no vscode dependency).
 */
export interface IFileParser {
    /**
     * Walk a tree-sitter CST and emit an array of symbol arrays
     * suitable for writing to an `*.idx` file. The layout of each
     * inner array is parser-private — only this parser's `readIndex()`
     * needs to understand it.
     *
     * @param rootNode - The root SyntaxNode from web-tree-sitter, or `null`
     *                   if no grammar is available (e.g. defaultParser)
     * @param filePath - Absolute path to the source file (for logging / context)
     * @returns Array of symbol arrays (one inner array per extracted symbol)
     */
    parseCst(rootNode: SyntaxNode | null, filePath: string): unknown[][];

    /**
     * Hydrate symbol arrays (read from an `*.idx` file) into fully
     * typed {@link IndexSymbol} objects.
     *
     * @param symbols - The raw symbol arrays from the {@link IndexFile} tuple
     * @returns Array of IndexSymbol objects
     */
    readIndex(symbols: unknown[][]): IndexSymbol[];

    /**
     * Split a source file into overlapping text chunks suitable for
     * embedding. The parser uses the hydrated `IndexSymbol[]` (produced
     * by `readIndex()` from the `*.idx` file) to align chunk boundaries
     * with structural elements (e.g. functions, classes, headings).
     *
     * Fully decoupled from the CST step — no web-tree-sitter re-parse
     * is needed. Runs in worker threads (no vscode dependency).
     *
     * @param sourceLines - The source file split into lines
     * @param symbols     - The `IndexSymbol[]` from `readIndex()`
     * @param filePath    - Absolute path (used for the context prefix)
     * @returns Array of Chunk objects
     */
    computeChunks(
        sourceLines: readonly string[],
        symbols: readonly IndexSymbol[],
        filePath: string,
    ): Chunk[];

    /**
     * File extensions this parser handles (e.g. `[".cc", ".cpp", ".h"]`).
     * Used by the registry to route files to the correct parser.
     * Empty for the default parser (it matches everything not claimed
     * by a language-specific parser).
     */
    readonly supportedExtensions: readonly string[];

    /**
     * The WASM grammar filename(s) for web-tree-sitter
     * (e.g. `"cpp.wasm"`, `"python.wasm"`).
     * Empty for the default parser (no tree-sitter grammar needed).
     */
    readonly wasmGrammars: readonly string[];

    /**
     * Parser-specific format version written into the {@link IndexFile}
     * tuple at index `[1]`. Each parser owns its version independently —
     * bumping one parser's version only invalidates `*.idx` files produced
     * by that parser.
     *
     * Bump this when the on-disk symbol layout changes.
     */
    readonly formatVersion: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Human-readable name for each {@link SymbolType} value. */
const SYMBOL_TYPE_NAMES: Record<number, string> = {
    [SymbolType.Namespace]: 'Namespace',
    [SymbolType.Class]: 'Class',
    [SymbolType.Struct]: 'Struct',
    [SymbolType.Union]: 'Union',
    [SymbolType.Enum]: 'Enum',
    [SymbolType.Function]: 'Function',
    [SymbolType.Method]: 'Method',
    [SymbolType.Constructor]: 'Constructor',
    [SymbolType.Destructor]: 'Destructor',
    [SymbolType.Prototype]: 'Prototype',
    [SymbolType.SourceInclude]: 'Include',
    [SymbolType.CodeComment]: 'Comment',
    [SymbolType.Macro]: 'Macro',
};

/**
 * Convert a {@link SymbolType} value to a human-readable string.
 * Returns `'Unknown'` for unrecognized values.
 */
export function symbolTypeToString(type: SymbolType): string {
    return SYMBOL_TYPE_NAMES[type] ?? 'Unknown';
}

/**
 * Set of {@link SymbolType} values representing callable symbols.
 * Used for signature display, parameter extraction, etc.
 */
export const CALLABLE_TYPES: ReadonlySet<SymbolType> = new Set<SymbolType>([
    SymbolType.Function,
    SymbolType.Method,
    SymbolType.Constructor,
    SymbolType.Destructor,
    SymbolType.Prototype,
]);

/**
 * Set of {@link SymbolType} values representing structural containers.
 * Used by `getContainer()` and structure-aware chunking.
 */
export const CONTAINER_TYPES: ReadonlySet<SymbolType> = new Set<SymbolType>([
    SymbolType.Namespace,
    SymbolType.Class,
    SymbolType.Struct,
    SymbolType.Union,
    SymbolType.Enum,
    SymbolType.Function,
    SymbolType.Method,
    SymbolType.Constructor,
    SymbolType.Destructor,
]);
