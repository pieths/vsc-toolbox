// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import { Query } from 'web-tree-sitter';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { SymbolType } from '../types';


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
    return node.text
        .substring(0, funcDecl.endIndex - node.startIndex)
        .replace(/\s+/g, ' ')
        .replace(/\(\s+/g, '(')
        .replace(/\s+\)/g, ')')
        .trim();
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
export const enum NumsMarker {
    /** Body-start position (line, col).  Payload: 2 numbers. */
    BodyStart = 0,
}

/** Number of values following each {@link NumsMarker}. */
export const NUMS_MARKER_PAYLOAD: Record<number, number> = {
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
export function extractSymbolsFromSyntaxTree(rootNode: SyntaxNode): unknown[][] {
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
