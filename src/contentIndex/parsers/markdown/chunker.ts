// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as path from 'path';
import type { Chunk, ChunkingConfig } from '../types';
import { SymbolType, } from '../types';
import type { IndexSymbol } from '../types';
import { splitIntoChunks, getPrefixBudget, type ChunkRange } from '../chunkUtils';

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

/** Fixed overhead for "---\nfile: \n---\n\n" (no section line). */
const FILE_ONLY_OVERHEAD = 16;

/** Fixed overhead for "---\nfile: \nsection: \n---\n\n" (with section line). */
const FULL_PREFIX_OVERHEAD = 26;

/**
 * Build a context prefix string for a chunk using YAML front-matter syntax.
 * Falls back gracefully if the full prefix exceeds the budget:
 *  1. Full prefix with section breadcrumb
 *  2. Without section line
 *  3. File name only
 *  4. Empty string if nothing fits
 *
 * @param filePath - Display path for the file
 * @param maxPrefixChars - Maximum allowed prefix length from getPrefixBudget()
 * @param section - Optional section range with breadcrumb
 */
function buildContextPrefix(
    filePath: string,
    maxPrefixChars: number,
    section?: SectionRange,
): string {
    // Try full prefix with section (length check before string allocation)
    if (section) {
        if (FULL_PREFIX_OVERHEAD + filePath.length + section.breadcrumb.length <= maxPrefixChars) {
            return `---\nfile: ${filePath}\nsection: ${section.breadcrumb}\n---\n\n`;
        }
    }

    // Try without section
    if (FILE_ONLY_OVERHEAD + filePath.length <= maxPrefixChars) {
        return `---\nfile: ${filePath}\n---\n\n`;
    }

    // Fall back to basename only (avoids ambiguous truncated paths)
    const basename = path.basename(filePath);
    if (FILE_ONLY_OVERHEAD + basename.length <= maxPrefixChars) {
        return `---\nfile: ${basename}\n---\n\n`;
    }

    return '';
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

export async function computeChunks(
    sourceLines: readonly string[],
    symbols: readonly IndexSymbol[],
    filePath: string,
    config: ChunkingConfig,
): Promise<Chunk[]> {
    const totalLines = sourceLines.length;
    const maxPrefixChars = getPrefixBudget(config.maxCharacters);

    // 1. Filter to heading symbols and build per-section ranges
    const headingSymbols = symbols.filter(
        s => s.type === SymbolType.MarkdownHeading1
            || s.type === SymbolType.MarkdownHeading2,
    );
    const sectionRanges = buildSectionRanges(headingSymbols, sourceLines);

    // 2. Collect all ChunkRanges (gaps + sections) in document order
    const chunkRanges: ChunkRange[] = [];
    let cursor = 0;

    for (const range of sectionRanges) {
        // Gap before this section (e.g. front-matter, intro text)
        if (cursor < range.startLine) {
            const prefix = buildContextPrefix(filePath, maxPrefixChars);
            chunkRanges.push({
                startLine: cursor,
                endLine: range.startLine,
                primaryPrefix: prefix,
                secondaryPrefix: prefix,
            });
        }

        // The section itself with heading-aware prefix
        const prefix = buildContextPrefix(filePath, maxPrefixChars, range);
        chunkRanges.push({
            startLine: range.startLine,
            endLine: range.endLine,
            primaryPrefix: prefix,
            secondaryPrefix: prefix,
        });

        cursor = range.endLine;
    }

    // Trailing lines after the last section
    if (cursor < totalLines) {
        const prefix = buildContextPrefix(filePath, maxPrefixChars);
        chunkRanges.push({
            startLine: cursor,
            endLine: totalLines,
            primaryPrefix: prefix,
            secondaryPrefix: prefix,
        });
    }

    // 3. Single call to splitIntoChunks for the entire file
    const result = await splitIntoChunks(sourceLines, chunkRanges, config);
    return result.flat();
};

// ── Test-only exports ───────────────────────────────────────────────────────
// These are internal helpers exported solely for unit testing.
// Do not use outside of test files.

export {
    buildContextPrefix as _buildContextPrefix,
    FILE_ONLY_OVERHEAD as _FILE_ONLY_OVERHEAD,
    FULL_PREFIX_OVERHEAD as _FULL_PREFIX_OVERHEAD,
};
