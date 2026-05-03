// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import { Query } from 'web-tree-sitter';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { SymbolType, } from '../types';
import type { IndexSymbol } from '../types';


// ── Query-based CST heading extraction ──────────────────────────────────────

/**
 * Tree-sitter S-expression query for Markdown ATX headings (levels 1–2).
 *
 * Each pattern captures the `atx_heading` node (`@heading`) and its
 * heading content (`@name`).  The pattern index determines the heading
 * level (see {@link QueryPattern}).
 *
 * The parent `section` node — which gives the full section extent — is
 * obtained programmatically from `heading.parent` rather than captured
 * in the query, because tree-sitter queries match descendants (not just
 * direct children), and capturing `section` would produce spurious
 * matches from ancestor sections.
 */
const MD_HEADING_QUERY = `
(atx_heading (atx_h1_marker) heading_content: (inline) @name) @heading
(atx_heading (atx_h2_marker) heading_content: (inline) @name) @heading
`;

/**
 * Pattern indices into {@link MD_HEADING_QUERY}.
 * Must match the declaration order of patterns in the query string.
 */
const enum QueryPattern {
    H1 = 0,
    H2 = 1,
}

/** Map heading-pattern indices to {@link SymbolType} values. */
const PATTERN_TO_SYMBOL_TYPE: Record<number, SymbolType> = {
    [QueryPattern.H1]: SymbolType.MarkdownHeading1,
    [QueryPattern.H2]: SymbolType.MarkdownHeading2,
};

/** Lazily compiled query, cached per Language instance. */
let _cachedQuery: Query | undefined;
let _cachedLanguage: unknown;

function getHeadingQuery(rootNode: SyntaxNode): Query {
    const language = rootNode.tree.language;
    if (_cachedQuery && _cachedLanguage === language) {
        return _cachedQuery;
    }
    _cachedQuery = new Query(language, MD_HEADING_QUERY);
    _cachedLanguage = language;
    return _cachedQuery;
}


// ── Position helpers ────────────────────────────────────────────────────────

/**
 * Extract 0-based positions from a section node, normalizing trailing
 * newlines so the end position follows the {@link IndexSymbol} convention
 * (endLine = line of last content character, endColumn = one past it).
 *
 * tree-sitter-markdown sections may include trailing newlines (including
 * blank lines between sections), pushing `endPosition` to `(nextRow, 0)`.
 * This function clamps back to the last line with actual content.
 *
 * @returns `[startLine, startCol, endLine, endCol]` (0-based, end-exclusive column)
 */
function sectionPosition(sectionNode: SyntaxNode): [number, number, number, number] {
    const startRow = sectionNode.startPosition.row;
    const startCol = sectionNode.startPosition.column;
    let endRow = sectionNode.endPosition.row;
    let endCol = sectionNode.endPosition.column;

    // Normalize: if the end is at column 0 of a subsequent row, the node
    // text ends with one or more newlines.  Walk backward past them to
    // find the last line with real content.
    if (endCol === 0 && endRow > startRow) {
        const text = sectionNode.text;
        let i = text.length - 1;
        while (i >= 0 && text.charCodeAt(i) === 0x0A /* \n */) {
            i--;
        }
        if (i < 0) {
            // Entire text is newlines — degenerate section.
            return [startRow, startCol, startRow, startCol];
        }
        // Adjust endRow by the number of trailing newlines skipped.
        const trailingNewlines = text.length - 1 - i;
        endRow -= trailingNewlines;
        // Compute exclusive endCol from the position of i relative to
        // the last preceding newline (or start of text if on the first line).
        const lastNL = text.lastIndexOf('\n', i);
        endCol = i - lastNL; // distance from newline+1 to i, plus 1 for exclusive
    }

    return [startRow, startCol, endRow, endCol];
}


// ── CST extraction ──────────────────────────────────────────────────────────

/**
 * Extract heading symbols from the CST using a tree-sitter query.
 *
 * On-disk symbol layout (positions are 0-based, end-exclusive column):
 * - Index 0: `number[]` — fixed 9-element array:
 *   `[SymbolType, startLine, startCol, endLine, endCol,
 *    nameStartLine, nameStartCol, nameEndLine, nameEndCol]`
 * - Index 1: `string[]` — `[name]`
 */
export function extractSymbolsFromSyntaxTree(rootNode: SyntaxNode): unknown[][] {
    const query = getHeadingQuery(rootNode);
    const matches = query.matches(rootNode);
    const results: unknown[][] = [];

    for (const match of matches) {
        const symType = PATTERN_TO_SYMBOL_TYPE[match.patternIndex];
        if (symType === undefined) continue;

        // Resolve captures by name for clarity.
        const headingNode = match.captures.find(c => c.name === 'heading')!.node;
        const nameNode = match.captures.find(c => c.name === 'name')!.node;

        // The section is the parent of the atx_heading.
        const sectionNode = headingNode.parent;
        if (!sectionNode || sectionNode.type !== 'section') continue;

        const name = nameNode.text.trim();
        if (!name) continue; // skip empty headings

        const [startLine, startCol, endLine, endCol] = sectionPosition(sectionNode);
        const nsl = nameNode.startPosition.row;
        const nsc = nameNode.startPosition.column;
        const nel = nameNode.endPosition.row;
        const nec = nameNode.endPosition.column;

        const nums = [symType, startLine, startCol, endLine, endCol, nsl, nsc, nel, nec];
        results.push([nums, [name]]);
    }

    return results;
}
