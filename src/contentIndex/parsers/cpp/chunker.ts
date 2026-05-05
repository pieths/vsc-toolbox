// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as path from 'path';
import type { Chunk, ChunkingConfig } from '../types';
import { SymbolType, AttrKey, symbolTypeToString, } from '../types';
import type { IndexSymbol } from '../types';
import { splitIntoChunks, getPrefixBudget, type ChunkRange } from '../chunkUtils';
import type { BoilerplateFilter } from '../chunkUtils';

// ── C++ boilerplate detection (Chunking) ─────────────────────────────────────

/**
 * Check whether a single line is purely C/C++ boilerplate that adds no
 * meaningful content for embedding search (e.g. closing braces,
 * preprocessor guards, standalone comments).
 */
function isBoilerplateLine(trimmedLine: string): boolean {
    if (!trimmedLine) return true;                                         // blank line
    if (trimmedLine.startsWith('//')) return true;                         // comment
    if (/^\}[;,]?\s*(\/\/.*)?$/.test(trimmedLine)) return true;            // closing brace
    if (trimmedLine.startsWith('#endif')) return true;                     // #endif guard
    if (trimmedLine.startsWith('#pragma once')) return true;               // #pragma once
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

/** Fixed overhead for "// file: \n\n" (no container line). */
const FILE_ONLY_OVERHEAD = 11;

/** Fixed overhead for "// file: \n// : \n\n" (with container, no signature). */
const CONTAINER_OVERHEAD = 17;

/** Extra overhead for "\n// signature: " when adding a signature line. */
const SIGNATURE_LINE_OVERHEAD = 15;

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
 *
 * Falls back gracefully if the full prefix exceeds the budget:
 *  1. Full prefix (with container and optional signature)
 *  2. Without signature line
 *  3. Without container line (file path only)
 *  4. File name only
 *  5. Empty string if nothing fits
 */
function buildContextPrefix(
    filePath: string,
    maxPrefixChars: number,
    container?: { kind: string; qualifiedName: string; signature?: string },
    includeSignature: boolean = false,
): string {
    if (container) {
        const containerLen =
            CONTAINER_OVERHEAD +
            filePath.length +
            container.kind.length +
            container.qualifiedName.length;

        // Try with signature line
        if (includeSignature && SIGNATURE_KINDS.has(container.kind) && container.signature) {
            if (containerLen + SIGNATURE_LINE_OVERHEAD + container.signature.length <= maxPrefixChars) {
                return `// file: ${filePath}\n// ${container.kind}: ${container.qualifiedName}\n// signature: ${container.signature}\n\n`;
            }
        }

        // Try with container but no signature
        if (containerLen <= maxPrefixChars) {
            return `// file: ${filePath}\n// ${container.kind}: ${container.qualifiedName}\n\n`;
        }
    }

    // Try file path only
    if (FILE_ONLY_OVERHEAD + filePath.length <= maxPrefixChars) {
        return `// file: ${filePath}\n\n`;
    }

    // Fall back to basename only (avoids ambiguous truncated paths)
    const basename = path.basename(filePath);
    if (FILE_ONLY_OVERHEAD + basename.length <= maxPrefixChars) {
        return `// file: ${basename}\n\n`;
    }

    return '';
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

export async function computeChunks(
    sourceLines: readonly string[],
    symbols: readonly IndexSymbol[],
    filePath: string,
    config: ChunkingConfig,
): Promise<Chunk[]> {
    const totalLines = sourceLines.length;
    const maxPrefixChars = getPrefixBudget(config.maxCharacters);

    // 1. Filter to container symbols and build top-level ranges
    const containerSymbols = symbols.filter(s => CHUNK_CONTAINER_TYPES.has(s.type));
    const topLevelRanges = findTopLevelRanges(containerSymbols);
    expandRangesToIncludePrecedingLines(topLevelRanges, sourceLines);

    // 2. Collect all ChunkRanges (gaps + containers) in document order
    const chunkRanges: ChunkRange[] = [];
    let cursor = 0;

    // Skip preamble (copyright header, include guard, #include
    // directives) so it doesn't pollute embedding chunks.
    cursor = findPreambleEnd(symbols);

    for (const range of topLevelRanges) {
        // Gap before this container (includes, forward decls, etc.)
        if (cursor < range.startLine) {
            const prefix = buildContextPrefix(filePath, maxPrefixChars);
            chunkRanges.push({
                startLine: cursor,
                endLine: range.startLine,
                primaryPrefix: prefix,
                secondaryPrefix: prefix,
            });
        }

        // The container itself — first chunk gets no signature,
        // subsequent chunks get the signature for callable containers.
        const primaryPrefix = buildContextPrefix(filePath, maxPrefixChars, range);
        const secondaryPrefix = buildContextPrefix(filePath, maxPrefixChars, range, true);
        chunkRanges.push({
            startLine: range.startLine,
            endLine: range.endLine,
            primaryPrefix,
            secondaryPrefix,
        });

        cursor = range.endLine;
    }

    // Trailing lines after the last container
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
    const result = await splitIntoChunks(
        sourceLines, chunkRanges, config, isCppBoilerplate,
    );
    return result.flat();
};

// ── Test-only exports ───────────────────────────────────────────────────────
// These are internal helpers exported solely for unit testing.
// Do not use outside of test files.

export {
    buildContextPrefix as _buildContextPrefix,
    FILE_ONLY_OVERHEAD as _FILE_ONLY_OVERHEAD,
    CONTAINER_OVERHEAD as _CONTAINER_OVERHEAD,
    SIGNATURE_LINE_OVERHEAD as _SIGNATURE_LINE_OVERHEAD,
};
