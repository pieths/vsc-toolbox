// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Markdown file parser.
 *
 * Handles `.md` files using only the block-level tree-sitter grammar
 * (`markdown.wasm`). The inline grammar (`markdown_inline.wasm`) is
 * intentionally not loaded — heading text is kept as-is, including any
 * inline Markdown formatting (e.g. `**bold**`, `` `code` ``).
 *
 * Only ATX headings at levels 1 (`#`) and 2 (`##`) are extracted.
 * Each heading produces a symbol whose extent covers the entire
 * {@link https://spec.commonmark.org/0.31.2/#sections section} —
 * from the `#` marker through to the character before the next
 * same-or-higher-level heading (or EOF). Level-2 sections nest
 * inside level-1 sections, analogous to methods inside namespaces
 * in C++.
 *
 * - {@link markdownParser.parseCst parseCst} uses a tree-sitter query
 *   to extract heading symbols as compact arrays for `*.idx` files.
 * - {@link markdownParser.readIndex readIndex} hydrates those arrays
 *   into typed {@link IndexSymbol} objects.
 * - {@link markdownParser.computeChunks computeChunks} produces
 *   heading-aware embedding chunks aligned to section boundaries.
 */

import { Query } from 'web-tree-sitter';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Chunk } from '../types';
import {
    SymbolType,
} from './types';
import type { IndexSymbol, IFileParser, MutableAttrMap } from './types';
import { splitIntoChunks, chunksToOneBased } from './chunkUtils';


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
function extractSymbolsFromSyntaxTree(rootNode: SyntaxNode): unknown[][] {
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


// ── Context prefix helpers (Chunking) ───────────────────────────────────────

/**
 * A section range with breadcrumb context for chunking.
 * Line numbers are 0-based end-exclusive.
 */
interface SectionRange {
    /** 0-based start line (inclusive) */
    startLine: number;
    /** 0-based end line (exclusive) */
    endLine: number;
    /** Breadcrumb string for the context prefix (e.g. "API Reference > Methods") */
    readonly breadcrumb: string;
}

/**
 * Build a context prefix string for a chunk using YAML front-matter syntax.
 *
 * ```
 * ---
 * file: <filePath>
 * section: <breadcrumb>  ← only if inside a heading section
 * ---
 *
 * ```
 */
function buildContextPrefix(
    filePath: string,
    section?: SectionRange,
): string {
    let prefix = `---\nfile: ${filePath}`;
    if (section) {
        prefix += `\nsection: ${section.breadcrumb}`;
    }
    return prefix + '\n---\n\n';
}

/**
 * Prepend a context prefix to each chunk's text (mutates in place).
 */
function prependPrefixes(
    chunks: Chunk[],
    filePath: string,
    section?: SectionRange,
): void {
    const prefix = buildContextPrefix(filePath, section);
    for (const chunk of chunks) {
        chunk.text = prefix + chunk.text;
    }
}


// ── Structure-aware chunking helpers (computeChunks) ────────────────────────

/**
 * Check whether a line range contains meaningful body text
 * (i.e. non-whitespace content beyond just the heading line itself).
 *
 * @param sourceLines - All lines in the file (0-based array)
 * @param startLine   - 0-based start line (inclusive); the line after the heading
 * @param endLine     - 0-based end line (exclusive)
 * @returns `true` if there is at least one non-blank line in the range
 */
function hasBodyContent(
    sourceLines: readonly string[],
    startLine: number,
    endLine: number,
): boolean {
    for (let i = startLine; i < endLine; i++) {
        if (sourceLines[i].trim()) return true;
    }
    return false;
}

/**
 * Build a flat list of section ranges from heading symbols.
 *
 * Each heading (H1 or H2) produces its own section range.  For H1 sections
 * that contain child H2s, the H1 range covers only the content between
 * the H1 heading and the first child H2 (the "intro" text).  Each H2 gets
 * its own range covering its full section extent.
 *
 * Breadcrumbs are built hierarchically:
 *  - H1 → `"Chapter Name"`
 *  - H2 inside H1 → `"Chapter Name > Section Name"`
 *  - Standalone H2 (no parent H1) → `"Section Name"`
 *
 * Sections with no body content (only the heading line and whitespace)
 * are excluded from the output.
 *
 * All positions are 0-based end-exclusive.
 *
 * @param symbols     - Heading symbols (H1 and H2) sorted by start line
 * @param sourceLines - All lines in the file (for empty-section detection)
 * @returns Section ranges in document order, excluding empty sections
 */
function buildSectionRanges(
    symbols: readonly IndexSymbol[],
    sourceLines: readonly string[],
): SectionRange[] {
    const sorted = symbols.slice().sort((a, b) => a.startLine - b.startLine);
    const sections: SectionRange[] = [];

    let currentH1Name: string | undefined;
    let currentH1Start = -1;   // 0-based start of the current H1 section
    let currentH1End = -1;     // 0-based exclusive end of the current H1 section

    for (let i = 0; i < sorted.length; i++) {
        const sym = sorted[i];
        // Convert IndexSymbol.endLine (inclusive) to exclusive.
        const symEndExcl = sym.endLine + 1;
        // The body starts on the line after the heading name.
        const bodyStart = sym.nameEndLine + 1;

        if (sym.type === SymbolType.MarkdownHeading1) {
            // Close previous H1 intro range if there was one that hasn't
            // been fully consumed by child H2s — handled implicitly since
            // we emit the H1 intro range right here.

            currentH1Name = sym.name;
            currentH1Start = sym.startLine;
            currentH1End = symEndExcl;

            // The H1 "intro" ends at the start of the next symbol
            // (which would be the first child H2), or at the end of
            // the H1 section if there are no more symbols within it.
            const next = sorted[i + 1];
            const introEnd = (next && next.startLine < symEndExcl)
                ? next.startLine
                : symEndExcl;

            // Only emit if the intro has body content
            if (hasBodyContent(sourceLines, bodyStart, introEnd)) {
                sections.push({
                    startLine: sym.startLine,
                    endLine: introEnd,
                    breadcrumb: sym.name,
                });
            }
        } else {
            // MarkdownHeading2
            const isInsideH1 = currentH1Start >= 0 &&
                sym.startLine >= currentH1Start &&
                symEndExcl <= currentH1End;

            const breadcrumb = isInsideH1 && currentH1Name
                ? `${currentH1Name} > ${sym.name}`
                : sym.name;

            // Only emit if the section has body content
            if (hasBodyContent(sourceLines, bodyStart, symEndExcl)) {
                sections.push({
                    startLine: sym.startLine,
                    endLine: symEndExcl,
                    breadcrumb,
                });
            }
        }
    }

    return sections;
}


// ── Parser singleton ────────────────────────────────────────────────────────

/**
 * Markdown parser singleton implementing {@link IFileParser}.
 */
export const markdownParser: IFileParser = {
    supportedExtensions: ['.md'],
    wasmGrammars: ['markdown.wasm'],
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

        // 1. Filter to heading symbols and build per-section ranges
        const headingSymbols = symbols.filter(
            s => s.type === SymbolType.MarkdownHeading1
                || s.type === SymbolType.MarkdownHeading2,
        );
        const sectionRanges = buildSectionRanges(headingSymbols, sourceLines);

        // All positions below are 0-based end-exclusive.
        const chunks: Chunk[] = [];
        let cursor = 0;

        // 2. Walk through section ranges, chunking gaps and sections
        for (const range of sectionRanges) {
            // Chunk the gap before this section (e.g. front-matter, intro text)
            if (cursor < range.startLine) {
                const gapChunks = splitIntoChunks(sourceLines, cursor, range.startLine);
                prependPrefixes(gapChunks, filePath);
                chunks.push(...gapChunks);
            }

            // Chunk the section itself with heading-aware prefix
            const sectionChunks = splitIntoChunks(
                sourceLines, range.startLine, range.endLine,
            );
            prependPrefixes(sectionChunks, filePath, range);
            chunks.push(...sectionChunks);

            cursor = range.endLine;
        }

        // 3. Chunk any trailing lines after the last section
        if (cursor < totalLines) {
            const trailingChunks = splitIntoChunks(sourceLines, cursor, totalLines);
            prependPrefixes(trailingChunks, filePath);
            chunks.push(...trailingChunks);
        }

        // Convert from 0-based end-exclusive to 1-based end-inclusive
        // (the public Chunk contract used by the rest of the extension).
        chunksToOneBased(chunks);
        return chunks;
    },
};
