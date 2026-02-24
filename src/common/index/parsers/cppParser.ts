// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * C / C++ / header file parser.
 *
 * Handles `.c`, `.cc`, `.cpp`, `.cxx`, `.h`, `.hh`, `.hpp`, `.hxx`.
 *
 * - {@link cppParser.parseCst parseCst} uses tree-sitter queries to
 *   extract symbols from the CST as compact arrays for `*.idx` files.
 * - {@link cppParser.readIndex readIndex} hydrates those arrays into
 *   typed {@link IndexSymbol} objects.
 * - {@link cppParser.computeChunks computeChunks} produces
 *   structure-aware embedding chunks aligned to function / class
 *   boundaries.
 */

import { Query } from 'web-tree-sitter';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Chunk } from '../types';
import {
    SymbolType,
    AttrKey,
    symbolTypeToString,
} from './types';
import type { IndexSymbol, IFileParser, MutableAttrMap } from './types';
import { splitIntoChunks, chunksToOneBased } from './chunkUtils';
import type { BoilerplateFilter } from './chunkUtils';


// ── Query-based CST symbol extraction ───────────────────────────────────────

/**
 * Tree-sitter S-expression query for all C/C++ symbol types.
 *
 * Each pattern captures a single outer node.  The pattern index
 * determines the symbol type (see {@link QueryPattern}).  Pattern
 * ordering matters: tree-sitter returns matches in document order,
 * with ties broken by pattern index — giving the same pre-order
 * traversal as a manual depth-first walk.
 *
 * Structural constraints (e.g. `declarator: (function_declarator)`)
 * replace the manual checks that were previously in `visit()` /
 * `findFunctionDeclarator()`.  The native query engine (C/WASM)
 * performs the tree walk, making this both simpler and faster.
 */
const CPP_SYMBOL_QUERY = `
(comment) @comment
(preproc_include) @include
(preproc_def) @macro
(preproc_function_def) @func_macro
(namespace_definition) @namespace
(class_specifier) @class
(struct_specifier) @struct
(enum_specifier) @enum
(union_specifier) @union
(function_definition) @func_def
(declaration declarator: (function_declarator)) @decl_proto
(field_declaration declarator: (function_declarator)) @field_proto
(declaration declarator: (pointer_declarator
    declarator: (function_declarator))) @decl_ptr_proto
(declaration declarator: (reference_declarator
    (function_declarator))) @decl_ref_proto
(field_declaration declarator: (pointer_declarator
    declarator: (function_declarator))) @field_ptr_proto
(field_declaration declarator: (reference_declarator
    (function_declarator))) @field_ref_proto
`;

/**
 * Pattern indices into {@link CPP_SYMBOL_QUERY}.
 * Must match the declaration order of patterns in the query string.
 */
const enum QueryPattern {
    Comment = 0,
    Include = 1,
    Macro = 2,
    FuncMacro = 3,
    Namespace = 4,
    Class = 5,
    Struct = 6,
    Enum = 7,
    Union = 8,
    FuncDef = 9,
    DeclProto = 10,
    FieldProto = 11,
    DeclPtrProto = 12,
    DeclRefProto = 13,
    FieldPtrProto = 14,
    FieldRefProto = 15,
}

/** Map container-pattern indices to {@link SymbolType} values. */
const PATTERN_TO_CONTAINER: Record<number, SymbolType> = {
    [QueryPattern.Namespace]: SymbolType.Namespace,
    [QueryPattern.Class]: SymbolType.Class,
    [QueryPattern.Struct]: SymbolType.Struct,
    [QueryPattern.Enum]: SymbolType.Enum,
    [QueryPattern.Union]: SymbolType.Union,
};

/** Lazily compiled query, cached per Language instance. */
let _cachedQuery: Query | undefined;
let _cachedLanguage: unknown;

function getSymbolQuery(rootNode: SyntaxNode): Query {
    const language = rootNode.tree.language;
    if (_cachedQuery && _cachedLanguage === language) {
        return _cachedQuery;
    }
    _cachedQuery = new Query(language, CPP_SYMBOL_QUERY);
    _cachedLanguage = language;
    return _cachedQuery;
}

/**
 * Extract 0-based positions from a CST node.
 *
 * Normalizes the trailing-newline quirk in preprocessor directive nodes:
 * tree-sitter-cpp includes the `\n` in `preproc_*` nodes, giving an
 * end position of `(nextLine, 0)`.  This clamps the end back to the
 * actual content end so all symbols have consistent positions.
 *
 * @returns `[startLine, startCol, endLine, endCol]` (0-based, end-exclusive)
 */
function nodePosition(node: SyntaxNode): [number, number, number, number] {
    let endRow = node.endPosition.row;
    let endCol = node.endPosition.column;
    // tree-sitter-cpp includes the trailing \n in preproc_* nodes,
    // making the end position bleed to (nextLine, 0).  Clamp it back
    // to the actual content end.
    if (node.type.startsWith('preproc_') && endCol === 0 && endRow > node.startPosition.row) {
        endRow -= 1;
        const text = node.text;
        const prevNL = text.lastIndexOf('\n', text.length - 2);
        endCol = text.length - prevNL - 2;
    }
    return [node.startPosition.row, node.startPosition.column, endRow, endCol];
}

/**
 * Extract 0-based positions for the name/identifier node.
 * Returns a zero-width range at (fallbackLine, fallbackCol) when the node
 * is null (e.g. anonymous namespaces, comments).
 */
function nameNodePos(
    node: SyntaxNode | null | undefined,
    fallbackLine: number,
    fallbackCol: number,
): [number, number, number, number] {
    if (!node) return [fallbackLine, fallbackCol, fallbackLine, fallbackCol];
    return [node.startPosition.row, node.startPosition.column,
    node.endPosition.row, node.endPosition.column];
}

/** Parent node types that represent a class or struct body. */
const CLASS_BODY_PARENTS = new Set([
    'field_declaration_list',  // direct child of class/struct body
]);

/**
 * Check whether a declarator subtree contains a `destructor_name` node.
 * The destructor_name node is `~ identifier` in tree-sitter-cpp.
 */
function hasDestructorName(node: SyntaxNode): boolean {
    if (node.type === 'destructor_name') return true;
    for (const child of node.children) {
        if (hasDestructorName(child)) return true;
    }
    return false;
}

/**
 * Classify a `function_definition` node into one of:
 * - {@link SymbolType.Destructor}  — no return type + `destructor_name` in declarator
 * - {@link SymbolType.Constructor} — no return type + no `destructor_name`
 * - {@link SymbolType.Method}      — has return type + inside class/struct body
 * - {@link SymbolType.Function}    — has return type + at file/namespace scope
 *
 * tree-sitter-cpp aliases both `constructor_or_destructor_definition` and
 * `inline_method_definition` to `function_definition` in the output AST,
 * so all four kinds arrive as the same node type.
 */
function classifyFunctionDef(node: SyntaxNode): SymbolType {
    const hasReturnType = node.childForFieldName('type') !== null;

    if (!hasReturnType) {
        // Constructor or Destructor — check for ~ in the declarator
        const declarator = node.childForFieldName('declarator');
        if (declarator && hasDestructorName(declarator)) {
            return SymbolType.Destructor;
        }

        // A real constructor is either inside a class body or has a
        // scope qualifier (e.g. Player::Player()).  A no-return-type
        // definition at file/namespace scope without :: is a macro
        // invocation like TEST_F(...) — classify as Function.
        const insideClassBody = node.parent && CLASS_BODY_PARENTS.has(node.parent.type);
        if (insideClassBody) {
            return SymbolType.Constructor;
        }
        const funcDecl = findFunctionDeclarator(node);
        const declText = funcDecl?.childForFieldName('declarator')?.text ?? '';
        if (declText.includes('::')) {
            return SymbolType.Constructor;
        }
        return SymbolType.Function;
    }

    // Has a return type — Method if inside a class/struct body, else Function
    if (node.parent && CLASS_BODY_PARENTS.has(node.parent.type)) {
        return SymbolType.Method;
    }
    return SymbolType.Function;
}

/**
 * Drill through `pointer_declarator`, `reference_declarator`, and similar
 * wrapper nodes to find the underlying `function_declarator`.
 *
 * In C/C++ the `*` / `&` / `&&` bind to the declarator, so tree-sitter
 * wraps `function_declarator` inside `pointer_declarator` etc. for
 * declarations like `int* foo(int x)`.
 */
function findFunctionDeclarator(node: SyntaxNode): SyntaxNode | null {
    let decl = node.childForFieldName('declarator');
    while (decl) {
        if (decl.type === 'function_declarator') return decl;
        decl = decl.childForFieldName('declarator')
            // tree-sitter-cpp's reference_declarator omits the
            // field('declarator') annotation, so fall back to the
            // first named child (the wrapped declarator).
            ?? (decl.type === 'reference_declarator' ? decl.namedChild(0) : null);
    }
    return null;
}

/**
 * Extract the name {@link SyntaxNode} from a CST node.
 *
 * - Containers (namespace, class, …) have a direct `name` field.
 * - Function definitions / declarations: drills into the
 *   `function_declarator` (through any pointer/reference wrappers)
 *   and returns only the leaf name node — e.g. the `play` node from
 *   `Player::play`, the `~Player` node from `Player::~Player`.
 */
function extractNameNode(node: SyntaxNode): SyntaxNode | null {
    const nameNode = node.childForFieldName('name');
    if (nameNode) return nameNode;

    const funcDecl = findFunctionDeclarator(node);
    if (funcDecl) {
        const inner = funcDecl.childForFieldName('declarator');
        if (!inner) return null;
        return inner.childForFieldName('name') ?? inner;
    }

    return null;
}

/**
 * Extract the full declarator name from a function node, including any
 * scope qualifier present in the source (e.g. `Player::play`).
 *
 * Used to build the fully-qualified name (FQN) for out-of-line
 * definitions where the source-level qualifier supplements the
 * scope derived from parent nodes.
 */
function extractDeclName(node: SyntaxNode): string {
    const funcDecl = findFunctionDeclarator(node);
    const declText = funcDecl?.childForFieldName('declarator')?.text;
    return declText ?? extractNameNode(node)?.text ?? '';
}

/**
 * Walk up the parent chain collecting namespace / class / struct names
 * joined by `::`. Unnamed namespaces contribute `(anonymous namespace)`.
 *
 * @returns The scope string, or `undefined` if the node is at file scope.
 */
function extractScope(node: SyntaxNode): string | undefined {
    const parts: string[] = [];
    let current = node.parent;
    while (current) {
        if (current.type === 'namespace_definition' ||
            current.type === 'class_specifier' ||
            current.type === 'struct_specifier') {
            const name = current.childForFieldName('name')?.text;
            if (name) {
                parts.unshift(name);
            } else if (current.type === 'namespace_definition') {
                parts.unshift('(anonymous namespace)');
            }
        }
        current = current.parent;
    }
    return parts.length > 0 ? parts.join('::') : undefined;
}

/**
 * Build the full signature string for a function / method / prototype node.
 *
 * Takes the source text from the node start to the end of its
 * `function_declarator`.  This naturally includes the return type,
 * any pointer / reference operators (`*`, `&`), the function name,
 * parameters, and trailing cv-qualifiers — while excluding the
 * function body and initializer lists.
 *
 * @example "int add(int a, int b)"
 * @example "int* getPointer(int x)"
 * @example "int getVolume() const"
 */
function buildSignature(node: SyntaxNode): string {
    const funcDecl = findFunctionDeclarator(node);
    if (!funcDecl) return '';
    return node.text.substring(0, funcDecl.endIndex - node.startIndex).trim();
}

/**
 * Extract the start position of a node's body (`{`).
 * Returns `null` when the node has no `body` field (e.g. forward declarations).
 */
function extractBodyStart(node: SyntaxNode): [number, number] | null {
    const body = node.childForFieldName('body');
    if (!body) return null;
    return [body.startPosition.row, body.startPosition.column];
}

/**
 * Numeric markers for optional tagged fields appended after the fixed
 * 9-element prefix in the `nums` array (index 0 of each symbol).
 *
 * Each marker implies a fixed payload size — the reader consumes that
 * many values immediately after the marker.  This allows arbitrary
 * future extensions without ambiguity.
 *
 * Only append new markers — never reorder or reuse retired values.
 */
const enum NumsMarker {
    /** Body-start position (line, col).  Payload: 2 numbers. */
    BodyStart = 0,
}

/** Number of values following each {@link NumsMarker}. */
const NUMS_MARKER_PAYLOAD: Record<number, number> = {
    [NumsMarker.BodyStart]: 2,
};

/**
 * Extract symbol arrays from the CST using a tree-sitter query.
 *
 * The native query engine (C/WASM) finds all matching nodes in document
 * order, replacing the former recursive `visit()` walk.  Structural
 * constraints in the query patterns handle the disambiguation that
 * previously required manual `node.type` checks and helper functions
 * like `findFunctionDeclarator()`.
 *
 * On-disk symbol layout (positions are 0-based, end-exclusive):
 * - Index 0: `number[]` — fixed 9-element prefix followed by zero or more
 *   tagged fields: `[SymbolType, startLine, startCol, endLine, endCol,
 *   nameStartLine, nameStartCol, nameEndLine, nameEndCol, marker?, ...payload?]`
 *   Each tagged field is a {@link NumsMarker} followed by its fixed-size payload.
 *   E.g. `[..., 0, bodyStartLine, bodyStartCol]` for {@link NumsMarker.BodyStart}.
 * - Index 1: `string[]` — varies by type (see inline comments)
 */
function extractSymbolsFromSyntaxTree(rootNode: SyntaxNode): unknown[][] {
    const query = getSymbolQuery(rootNode);
    const matches = query.matches(rootNode);
    const results: unknown[][] = [];

    /** Index into `results` of the last standalone `//` comment, or -1. */
    let lastStandaloneCommentIdx = -1;

    for (const match of matches) {
        const node = match.captures[0].node;
        const [startLine, startCol, endLine, endCol] = nodePosition(node);

        switch (match.patternIndex) {
            // ── Comment ──────────────────────────────────────────────
            case QueryPattern.Comment: {
                const isLineComment = node.text.startsWith('//');

                // A standalone comment has no previous sibling ending
                // on the same line (i.e. it's not trailing code).
                const prevSibling = node.previousNamedSibling;
                const isStandalone = isLineComment &&
                    (!prevSibling || prevSibling.endPosition.row < startLine);

                // Merge consecutive standalone // comments that share the
                // same start column into a single CodeComment symbol.
                if (isStandalone && lastStandaloneCommentIdx >= 0) {
                    const prev = results[lastStandaloneCommentIdx][0] as number[];
                    if (startLine === prev[3] + 1 && startCol === prev[2]) {
                        // Extend the previous comment's end position
                        prev[3] = endLine;
                        prev[4] = endCol;
                        break;
                    }
                }

                results.push([[SymbolType.CodeComment, startLine, startCol, endLine, endCol,
                    startLine, startCol, startLine, startCol]]);

                lastStandaloneCommentIdx = isStandalone
                    ? results.length - 1
                    : -1;
                break;
            }

            // ── Preprocessor include ─────────────────────────────────
            case QueryPattern.Include: {
                const pathNode = node.childForFieldName('path');
                const [nsl, nsc, nel, nec] = nameNodePos(pathNode, startLine, startCol);
                const nums = [SymbolType.SourceInclude, startLine, startCol, endLine, endCol, nsl, nsc, nel, nec];
                results.push([nums]);
                break;
            }

            // ── Preprocessor macro ───────────────────────────────────
            case QueryPattern.Macro:
            case QueryPattern.FuncMacro: {
                const macroNameNode = node.childForFieldName('name');
                const macroName = macroNameNode?.text ?? '';
                const [nsl, nsc, nel, nec] = nameNodePos(macroNameNode, startLine, startCol);
                const nums = [SymbolType.Macro, startLine, startCol, endLine, endCol, nsl, nsc, nel, nec];
                results.push([nums, [macroName]]);
                break;
            }

            // ── Containers: namespace, class, struct, enum, union ────
            case QueryPattern.Namespace:
            case QueryPattern.Class:
            case QueryPattern.Struct:
            case QueryPattern.Enum:
            case QueryPattern.Union: {
                const symType = PATTERN_TO_CONTAINER[match.patternIndex];
                const contNameNode = extractNameNode(node);
                const rawName = contNameNode?.text ?? '';
                const name = (!rawName && match.patternIndex === QueryPattern.Namespace)
                    ? '(anonymous namespace)' : rawName;
                const scope = extractScope(node);
                const fqn = scope ? `${scope}::${name}` : name;
                const [nsl, nsc, nel, nec] = nameNodePos(contNameNode, startLine, startCol);
                const nums: number[] = [symType, startLine, startCol, endLine, endCol, nsl, nsc, nel, nec];
                const bodyStart = extractBodyStart(node);
                if (bodyStart) { nums.push(NumsMarker.BodyStart, bodyStart[0], bodyStart[1]); }
                results.push([nums, [name, scope ?? '', fqn]]);
                break;
            }

            // ── Function definitions (classified in code) ────────────
            case QueryPattern.FuncDef: {
                const symType = classifyFunctionDef(node);
                const funcNameNode = extractNameNode(node);
                const name = funcNameNode?.text ?? '';
                let scope = extractScope(node);
                const declName = extractDeclName(node);
                const lastSep = declName.lastIndexOf('::');
                if (lastSep !== -1) {
                    const declScope = declName.substring(0, lastSep);
                    scope = scope ? `${scope}::${declScope}` : declScope;
                }
                const fqn = scope ? `${scope}::${name}` : name;
                const sig = buildSignature(node);
                const [nsl, nsc, nel, nec] = nameNodePos(funcNameNode, startLine, startCol);
                const nums: number[] = [symType, startLine, startCol, endLine, endCol, nsl, nsc, nel, nec];
                const bodyStart = extractBodyStart(node);
                if (bodyStart) { nums.push(NumsMarker.BodyStart, bodyStart[0], bodyStart[1]); }
                results.push([nums, [name, scope ?? '', fqn, sig]]);
                break;
            }

            // ── Declaration / field_declaration prototypes ───────────
            case QueryPattern.DeclProto:
            case QueryPattern.FieldProto:
            case QueryPattern.DeclPtrProto:
            case QueryPattern.DeclRefProto:
            case QueryPattern.FieldPtrProto:
            case QueryPattern.FieldRefProto: {
                const protoNameNode = extractNameNode(node);
                const name = protoNameNode?.text ?? '';
                let scope = extractScope(node);
                const declName = extractDeclName(node);
                const lastSep = declName.lastIndexOf('::');
                if (lastSep !== -1) {
                    const declScope = declName.substring(0, lastSep);
                    scope = scope ? `${scope}::${declScope}` : declScope;
                }
                const fqn = scope ? `${scope}::${name}` : name;
                const sig = buildSignature(node);
                const [nsl, nsc, nel, nec] = nameNodePos(protoNameNode, startLine, startCol);
                const nums = [SymbolType.Prototype, startLine, startCol, endLine, endCol, nsl, nsc, nel, nec];
                results.push([nums, [name, scope ?? '', fqn, sig]]);
                break;
            }
        }
    }

    return results;
}

// ── C++ boilerplate detection (Chunking) ─────────────────────────────────────

/**
 * Check whether a single line is purely C/C++ boilerplate that adds no
 * meaningful content for embedding search (e.g. closing braces,
 * preprocessor guards, standalone comments).
 */
function isBoilerplateLine(trimmedLine: string): boolean {
    if (!trimmedLine) return true;                                          // blank line
    if (trimmedLine.startsWith('//')) return true;                          // comment
    if (/^\}[;,]?\s*(\/\/.*)?$/.test(trimmedLine)) return true;            // closing brace
    if (trimmedLine.startsWith('#endif')) return true;                      // #endif guard
    if (trimmedLine.startsWith('#pragma once')) return true;                // #pragma once
    if (/^#(if|ifdef|ifndef|elif|else)\b/.test(trimmedLine)) return true;  // preprocessor conditional
    return false;
}

/**
 * Check whether a chunk consists entirely of C/C++ boilerplate lines.
 * Passed to {@link splitIntoChunks} as a {@link BoilerplateFilter}.
 */
const isCppBoilerplate: BoilerplateFilter = (trimmedText: string): boolean => {
    if (trimmedText.length > 200) {
        return false;
    }
    return trimmedText.split('\n').every(
        line => isBoilerplateLine(line.trim()),
    );
};

// ── Context prefix helpers (Chunking) ────────────────────────────────────────

/** Parser kinds that have a meaningful signature line. */
const SIGNATURE_KINDS = new Set([
    symbolTypeToString(SymbolType.Function),
    symbolTypeToString(SymbolType.Method),
    symbolTypeToString(SymbolType.Constructor),
    symbolTypeToString(SymbolType.Destructor),
    symbolTypeToString(SymbolType.Prototype),
]);

/**
 * Container types used for structure-aware chunking.
 * Excludes {@link SymbolType.Namespace} because namespaces typically
 * span the entire file and would prevent meaningful chunk boundaries.
 */
const CHUNK_CONTAINER_TYPES: ReadonlySet<SymbolType> = new Set<SymbolType>([
    SymbolType.Class,
    SymbolType.Struct,
    SymbolType.Union,
    SymbolType.Enum,
    SymbolType.Function,
    SymbolType.Method,
    SymbolType.Constructor,
    SymbolType.Destructor,
]);

/**
 * Build a context prefix string for a chunk.
 *
 * The prefix provides embedding context so each chunk can be understood
 * in isolation:
 *
 * ```
 * // file: <filePath>
 * // <kind>: <qualifiedName> ← only if inside a container
 * // signature: <signature>  ← only for non-first chunks of callable containers
 *
 * ```
 */
function buildContextPrefix(
    filePath: string,
    container?: { kind: string; qualifiedName: string; signature?: string },
    isFirstChunk: boolean = true,
): string {
    let prefix = `// file: ${filePath}`;

    if (container) {
        prefix += `\n// ${container.kind}: ${container.qualifiedName}`;

        if (!isFirstChunk && SIGNATURE_KINDS.has(container.kind) && container.signature) {
            prefix += `\n// signature: ${container.signature}`;
        }
    }

    return prefix + '\n\n';
}

/**
 * Prepend a context prefix to each chunk's text (mutates in place).
 *
 * The first chunk receives a basic prefix; subsequent chunks of a
 * callable container additionally receive a signature line so that
 * each chunk carries enough context for embedding search.
 */
function prependPrefixes(
    chunks: Chunk[],
    filePath: string,
    container?: { kind: string; qualifiedName: string; signature?: string },
): void {
    for (let i = 0; i < chunks.length; i++) {
        const isFirstChunk = i === 0;
        const prefix = buildContextPrefix(filePath, container, isFirstChunk);
        chunks[i].text = prefix + chunks[i].text;
    }
}

// ── Structure-aware chunking helpers (computeChunks) ────────────────────────

/**
 * A top-level container range with associated metadata for prefix generation.
 * Line numbers are 0-based end-exclusive (matching tree-sitter / VS Code).
 */
interface ContainerRange {
    /** 0-based start line (inclusive) */
    startLine: number;
    /** 0-based end line (exclusive) */
    endLine: number;
    /** Kind string for the context prefix (e.g. "Function", "Class") */
    kind: string;
    /** Fully qualified name of the outermost container */
    qualifiedName: string;
    /** Function/method signature, if available */
    signature?: string;
}

/**
 * Find top-level (non-nested) container ranges from symbols.
 * Overlapping or nested containers are merged into the outermost range.
 * Each range retains the metadata of the outermost container.
 *
 * All positions are 0-based end-exclusive.
 *
 * @param symbols - Container symbols sorted by start line
 * @returns Non-overlapping container ranges in document order
 */
function findTopLevelRanges(symbols: readonly IndexSymbol[]): ContainerRange[] {
    const sorted = symbols.slice().sort((a, b) => a.startLine - b.startLine);
    const topLevel: ContainerRange[] = [];
    let currentEnd = 0;

    for (const sym of sorted) {
        // Convert IndexSymbol.endLine (inclusive) to exclusive for ContainerRange.
        const symEndExcl = sym.endLine + 1;

        if (sym.startLine >= currentEnd) {
            // Starts at or after the current top-level range's end
            topLevel.push({
                startLine: sym.startLine,
                endLine: symEndExcl,
                kind: symbolTypeToString(sym.type),
                qualifiedName: sym.attrs.get(AttrKey.FullyQualifiedName) ?? sym.name,
                signature: sym.attrs.get(AttrKey.Signature),
            });
            currentEnd = symEndExcl;
        } else if (symEndExcl > currentEnd) {
            // Overlaps and extends beyond — merge into current range
            topLevel[topLevel.length - 1].endLine = symEndExcl;
            currentEnd = symEndExcl;
        }
        // Otherwise fully nested — skip
    }

    return topLevel;
}

/**
 * Expand container ranges upward to absorb non-empty lines immediately
 * preceding each container (e.g. comments, decorators, doc-strings
 * above a function definition).
 *
 * Ranges are assumed to be sorted in document order and non-overlapping
 * (as produced by {@link findTopLevelRanges}).
 * All positions are 0-based end-exclusive.
 *
 * @param ranges - Array of container ranges (modified in place)
 * @param lines  - All lines in the file (0-based array)
 */
function expandRangesToIncludePrecedingLines(
    ranges: ContainerRange[],
    lines: readonly string[],
): void {
    for (let i = 0; i < ranges.length; i++) {
        const range = ranges[i];
        // The lowest line we can claim is the previous container's exclusive
        // end, or line 0 if this is the first container.
        const lowerBound = i > 0 ? ranges[i - 1].endLine : 0;

        let candidate = range.startLine - 1; // line above current start
        while (candidate >= lowerBound) {
            if (!lines[candidate].trim()) {
                break; // hit an empty/whitespace-only line — stop
            }
            candidate--;
        }

        // candidate is now one below the first non-empty line we should keep,
        // or it stopped at an empty line. Start from the line after candidate.
        range.startLine = candidate + 1;
    }
}

/**
 * Find the 0-based exclusive end line of the file preamble.
 *
 * The preamble is everything up to and including the last `#include`
 * directive (copyright comments, include guards, `#pragma once`, and
 * the includes themselves).  Chunking starts from the returned line,
 * skipping all of that boilerplate.
 *
 * @returns The line after the last `SourceInclude` symbol (0-based,
 *          exclusive), or `0` if the file contains no includes.
 */
function findPreambleEnd(symbols: readonly IndexSymbol[]): number {
    let lastIncludeEndLine = -1;
    for (const sym of symbols) {
        if (sym.type === SymbolType.SourceInclude && sym.endLine > lastIncludeEndLine) {
            lastIncludeEndLine = sym.endLine;
        }
    }
    // endLine is inclusive (last line of the symbol), so +1 gives the
    // exclusive end — i.e. the first line after the last #include.
    return lastIncludeEndLine >= 0 ? lastIncludeEndLine + 1 : 0;
}

// ── Parser singleton ────────────────────────────────────────────────────────

/**
 * C / C++ parser singleton implementing {@link IFileParser}.
 */
export const cppParser: IFileParser = {
    supportedExtensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'],
    wasmGrammars: ['cpp.wasm'],
    formatVersion: 1,

    // ── parseCst ────────────────────────────────────────────────────────

    parseCst(rootNode: SyntaxNode | null, _filePath: string): unknown[][] {
        if (!rootNode) {
            return [];
        }
        return extractSymbolsFromSyntaxTree(rootNode);
    },

    // ── readIndex ───────────────────────────────────────────────────────

    readIndex(symbols: unknown[][]): IndexSymbol[] {
        return symbols.map(sym => {
            const nums = sym[0] as number[];
            const strings = (sym[1] as string[] | undefined) ?? [];
            const [type, startLine, startCol, endLine, endCol,
                nameStartLine, nameStartCol, nameEndLine, nameEndCol] = nums;

            const attrs = new Map() as MutableAttrMap;

            // SourceInclude: path is stored as the name (strings[0])
            // Macro: name is strings[0]
            // All other types: strings layout is [name, scope, fqn, signature?]
            if (type !== SymbolType.SourceInclude && type !== SymbolType.Macro) {
                // strings: [name, scope, fqn, signature?]
                if (strings[1]) {
                    attrs.set(AttrKey.Scope, strings[1]);
                }
                if (strings[2]) {
                    attrs.set(AttrKey.FullyQualifiedName, strings[2]);
                }
                if ((type === SymbolType.Function ||
                    type === SymbolType.Method ||
                    type === SymbolType.Constructor ||
                    type === SymbolType.Destructor ||
                    type === SymbolType.Prototype) && strings[3]) {
                    attrs.set(AttrKey.Signature, strings[3]);
                }
            }

            // Scan optional tagged fields from index 9 onward
            for (let i = 9; i < nums.length;) {
                const marker = nums[i];
                const payload = NUMS_MARKER_PAYLOAD[marker];
                if (payload === undefined) break; // unknown marker — stop
                switch (marker) {
                    case NumsMarker.BodyStart:
                        attrs.set(AttrKey.ContainerHeaderEndLine, nums[i + 1]);
                        attrs.set(AttrKey.ContainerHeaderEndColumn, nums[i + 2]);
                        break;
                }
                i += 1 + payload;
            }

            return {
                type,
                name: strings[0] ?? '',
                startLine,
                startColumn: startCol,
                endLine,
                endColumn: endCol,
                nameStartLine,
                nameStartColumn: nameStartCol,
                nameEndLine,
                nameEndColumn: nameEndCol,
                attrs,
            };
        });
    },

    // ── computeChunks ───────────────────────────────────────────────────

    computeChunks(
        sourceLines: readonly string[],
        symbols: readonly IndexSymbol[],
        filePath: string,
    ): Chunk[] {
        const totalLines = sourceLines.length;

        // 1. Filter to container symbols and build top-level ranges
        const containerSymbols = symbols.filter(s => CHUNK_CONTAINER_TYPES.has(s.type));
        const topLevelRanges = findTopLevelRanges(containerSymbols);
        expandRangesToIncludePrecedingLines(topLevelRanges, sourceLines);

        // All positions below are 0-based end-exclusive.
        const chunks: Chunk[] = [];
        let cursor = 0;

        // Skip preamble (copyright header, include guard, #include
        // directives) so it doesn't pollute embedding chunks.
        cursor = findPreambleEnd(symbols);

        // 2. Walk through container ranges, chunking gaps and containers
        for (const range of topLevelRanges) {
            // Chunk the gap before this container (includes, forward decls, etc.)
            if (cursor < range.startLine) {
                const gapChunks = splitIntoChunks(
                    sourceLines, cursor, range.startLine, isCppBoilerplate,
                );
                prependPrefixes(gapChunks, filePath);
                chunks.push(...gapChunks);
            }

            // Chunk the container itself with container-aware prefix
            const containerChunks = splitIntoChunks(
                sourceLines, range.startLine, range.endLine, isCppBoilerplate,
            );
            prependPrefixes(containerChunks, filePath, range);
            chunks.push(...containerChunks);

            cursor = range.endLine;
        }

        // 3. Chunk any trailing lines after the last container
        if (cursor < totalLines) {
            const trailingChunks = splitIntoChunks(
                sourceLines, cursor, totalLines, isCppBoilerplate,
            );
            prependPrefixes(trailingChunks, filePath);
            chunks.push(...trailingChunks);
        }

        // Convert from 0-based end-exclusive to 1-based end-inclusive
        // (the public Chunk contract used by the rest of the extension).
        chunksToOneBased(chunks);
        return chunks;
    },
};
