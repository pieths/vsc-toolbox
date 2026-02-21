// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * File chunking utilities for splitting source files into text chunks
 * suitable for embedding search. Supports structure-aware chunking for
 * C/C++ files using ctags container boundaries, and simple fixed-size
 * splitting for all other file types.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Chunk, ComputeChunksInput, ComputeChunksOutput } from '../../types';

// ── Chunking constants and helpers ──────────────────────────────────────────

/** Maximum number of lines per chunk for embedding */
const MAX_CHUNK_LINES = 150;

/** Number of overlapping lines between consecutive chunks (~20% of chunk size) */
const CHUNK_OVERLAP_LINES = 15;

/** Minimum character length for a chunk to be kept (filters out trivial chunks) */
const MIN_CHUNK_CHARS = 75;

/**
 * Check whether a single line is purely boilerplate that adds no meaningful
 * content for embedding search (e.g. closing braces, preprocessor guards,
 * standalone comments).
 *
 * @param trimmedLine - The trimmed (no leading/trailing whitespace) line text
 * @returns true if the line matches a known boilerplate pattern
 */
function isBoilerplateLine(trimmedLine: string): boolean {
    if (!trimmedLine) return true;                                      // blank line
    if (trimmedLine.startsWith('//')) return true;                      // comment
    if (/^\}[;,]?\s*(\/\/.*)?$/.test(trimmedLine)) return true;        // closing brace
    if (trimmedLine.startsWith('#endif')) return true;                  // #endif guard
    if (trimmedLine.startsWith('#pragma once')) return true;            // #pragma once
    if (/^#(if|ifdef|ifndef|elif|else)\b/.test(trimmedLine)) return true; // preprocessor conditional
    return false;
}

/**
 * Check whether a chunk consists entirely of boilerplate lines
 * (closing braces, comments, preprocessor guards, blank lines).
 * These chunks add noise to embedding search results without providing
 * meaningful content.
 *
 * @param trimmedText - The trimmed (no leading/trailing whitespace) chunk text
 * @returns true if every non-empty line matches a boilerplate pattern
 */
function isBoilerplateChunk(trimmedText: string): boolean {
    if (trimmedText.length > 200) {
        return false;
    }
    return trimmedText.split('\n').every(
        line => isBoilerplateLine(line.trim()),
    );
}

/** C/C++ file extensions that use ctags-based chunking */
const CPP_EXTENSIONS = new Set([
    '.c', '.cc', '.cpp', '.cxx',
    '.h', '.hh', '.hpp', '.hxx',
]);

/** ctags kinds that represent structural containers */
// TODO: should prototype be removed? It's creating a lot of one liners.
const CHUNK_CONTAINER_KINDS = new Set([
    'class', 'struct', 'union', 'function',
    'method', 'enum', 'interface'
]);

/**
 * Check whether a ctags entry is a preamble tag that should be
 * ignored when computing the first meaningful tag line.
 * Currently matches include guard macros (names ending in "_H_").
 */
function isPreambleTag(entry: { kind: string; name: string }): boolean {
    return entry.kind === 'macro' && entry.name.endsWith('_H_');
}

/** Minimal tag entry used for chunking */
interface TagEntry {
    name: string;
    line: number;
    end: number;
    kind: string;
    scope?: string;
    signature?: string;
    typeref?: string;
}

/** A top-level container range with associated tag metadata */
interface ContainerRange {
    /** 1-based start line */
    startLine: number;
    /** 1-based end line (inclusive) */
    endLine: number;
    /** ctags kind of the outermost container (e.g., "function", "class") */
    kind: string;
    /** Fully qualified name of the outermost container */
    qualifiedName: string;
    /** Function/method signature, if available */
    signature?: string;
}

/** Result of parsing a ctags JSON file */
interface ParsedTags {
    /** Container tag entries with line ranges */
    tags: TagEntry[];
    /**
     * 1-based line number of the first tag of any kind in the file,
     * or undefined if the file contains no tags at all.
     */
    firstTagLine: number | undefined;
}

/**
 * Parse a ctags JSON file and return container entries
 * that have an end line, along with the line number of
 * the very first tag (of any kind) in the file.
 *
 * @param tagsContent - Raw content of the ctags JSON file
 * @returns Parsed container tags and the first-tag line number
 */
function parseContainerTags(tagsContent: string): ParsedTags {
    const tags: TagEntry[] = [];
    let firstTagLine: number | undefined;

    for (const line of tagsContent.split('\n')) {
        if (!line.trim()) continue;

        // Fast-skip pseudo-tags and hash lines
        if (line.startsWith('{"_type": "ptag"')) continue;
        if (line.startsWith('{"_type": "sha256"')) continue;

        try {
            const entry = JSON.parse(line);
            if (entry._type !== 'tag') continue;

            // Track the earliest tag line across all tag kinds,
            // excluding preamble tags (e.g. include guard macros)
            // which appear at the top of header files.
            // Everything before this first tag will be filtered out.
            // Usually just copyright, includes and namespaces. There
            // might be some useful defines or comments before the first
            // tag but for now this is a simple heuristic to skip large
            // untagged preambles that are usually not relevant for search
            // and just add noise.
            if (!isPreambleTag(entry) &&
                (firstTagLine === undefined || entry.line < firstTagLine)) {
                firstTagLine = entry.line;
            }

            if (entry.end === undefined) continue;
            if (!CHUNK_CONTAINER_KINDS.has(entry.kind)) continue;

            tags.push({
                name: entry.name,
                line: entry.line,
                end: entry.end,
                kind: entry.kind,
                scope: entry.scope,
                signature: entry.signature,
                typeref: entry.typeref,
            });
        } catch {
            continue;
        }
    }

    return { tags, firstTagLine };
}

// Regex for replacing anonymous namespace markers (compiled once)
const ANON_NAMESPACE_REGEX = /__anon[a-fA-F0-9]+/g;

/**
 * Replace anonymous namespace markers (e.g., __anon1234abcd) with "(anonymous namespace)".
 * ctags uses these markers for unnamed namespaces in C++.
 */
function normalizeScope(scope: string): string {
    return scope.replace(ANON_NAMESPACE_REGEX, '(anonymous namespace)');
}

/**
 * Build the fully qualified name for a tag entry.
 * Combines scope (if present) with the tag name using "::" separator.
 * Anonymous namespace markers are normalized to "(anonymous namespace)".
 */
function buildQualifiedName(tag: TagEntry): string {
    const name = normalizeScope(tag.name);
    if (tag.scope) {
        return `${normalizeScope(tag.scope)}::${name}`;
    }
    return name;
}

/**
 * Build the full signature string for a tag entry.
 * Combines return type (from typeref), name, and parameters (from signature).
 * Example: "std::string GetExtProfile(VideoCodec codec)"
 *
 * @param tag - The tag entry to build the signature for
 * @returns The full signature string, e.g. "int add(int a, int b)" or "add(int a, int b)"
 */
function buildSignature(tag: TagEntry): string {
    let returnType = '';
    if (tag.typeref) {
        // typeref is typically "typename:ReturnType" or similar
        const colonIndex = tag.typeref.indexOf(':');
        if (colonIndex !== -1) {
            returnType = tag.typeref.substring(colonIndex + 1);
        } else {
            returnType = tag.typeref;
        }
    }

    const params = tag.signature || '';
    return returnType
        ? `${returnType} ${tag.name}${params}`
        : `${tag.name}${params}`;
}

/**
 * Find top-level (non-nested) container ranges from a set of tags.
 * Overlapping or nested containers are merged into the outermost range.
 * Each range retains the metadata (kind, name, signature) of the outermost container.
 *
 * @param tags - Array of tag entries sorted by start line
 * @returns Array of non-overlapping container ranges in document order
 */
function findTopLevelRanges(tags: TagEntry[]): ContainerRange[] {
    const sorted = tags.slice().sort((a, b) => a.line - b.line);
    const topLevel: ContainerRange[] = [];
    let currentEnd = 0;

    for (const tag of sorted) {
        if (tag.line > currentEnd) {
            // Starts after the current top-level range
            topLevel.push({
                startLine: tag.line,
                endLine: tag.end,
                kind: tag.kind,
                qualifiedName: buildQualifiedName(tag),
                signature: buildSignature(tag),
            });
            currentEnd = tag.end;
        } else if (tag.end > currentEnd) {
            // Overlaps and extends beyond – merge into current range
            topLevel[topLevel.length - 1].endLine = tag.end;
            currentEnd = tag.end;
        }
        // Otherwise fully nested – skip
    }

    return topLevel;
}

/**
 * Expand container ranges upward to absorb non-empty lines immediately
 * preceding each container (e.g. comments above a function definition).
 *
 * For each range, walk upward from its start line. As long as the
 * preceding line is non-empty (not whitespace-only) and not already
 * covered by a previous container range, absorb it into the current
 * container by moving its startLine up.
 *
 * Ranges are assumed to be sorted in document order and non-overlapping
 * (as produced by findTopLevelRanges).
 *
 * @param ranges - Array of container ranges (modified in place)
 * @param lines - Array of all lines in the file (0-based index)
 */
function expandRangesToIncludePrecedingLines(
    ranges: ContainerRange[],
    lines: string[],
): void {
    for (let i = 0; i < ranges.length; i++) {
        const range = ranges[i];
        // The lowest line we can claim is one past the previous container's
        // end, or line 1 if this is the first container.
        const lowerBound = i > 0 ? ranges[i - 1].endLine + 1 : 1;

        let candidate = range.startLine - 1; // 1-based line above current start
        while (candidate >= lowerBound) {
            // lines array is 0-based, so lines[candidate - 1]
            if (!lines[candidate - 1].trim()) {
                break; // hit an empty/whitespace-only line – stop
            }
            candidate--;
        }

        // candidate is now one below the first non-empty line we should keep,
        // or it stopped at an empty line. Start from the line after candidate.
        range.startLine = candidate + 1;
    }
}

/**
 * Split a line range into chunks of at most `maxLines` lines with overlap.
 * Empty (whitespace-only) chunks are discarded.
 * When the remaining lines fit in a single chunk, no overlap is added.
 *
 * @param lines - Array of all lines in the file (0-based index)
 * @param startLine - 1-based start line
 * @param endLine - 1-based end line (inclusive)
 * @param maxLines - Maximum lines per chunk
 * @param overlap - Number of overlapping lines between consecutive chunks
 * @returns Array of Chunk objects
 */
function splitIntoChunks(
    lines: string[],
    startLine: number,
    endLine: number,
    maxLines: number,
    overlap: number = CHUNK_OVERLAP_LINES,
): Chunk[] {
    const chunks: Chunk[] = [];
    const stride = maxLines - overlap;
    let current = startLine;

    while (current <= endLine) {
        const chunkEnd = Math.min(current + maxLines - 1, endLine);
        const text = lines.slice(current - 1, chunkEnd).join('\n');

        const trimmed = text.trim();
        if (trimmed && trimmed.length >= MIN_CHUNK_CHARS && !isBoilerplateChunk(trimmed)) {
            const sha256 = crypto.createHash('sha256').update(text).digest('hex');
            chunks.push({ startLine: current, endLine: chunkEnd, text, sha256 });
        }

        // If this chunk reached the end, we're done
        if (chunkEnd >= endLine) {
            break;
        }

        current += stride;
    }

    return chunks;
}

/** ctags kinds that can have a signature line in non-first chunk prefixes */
const SIGNATURE_KINDS = new Set(['function', 'method', 'prototype']);

/**
 * Compute the context prefix for a chunk.
 *
 * The prefix provides embedding context so that each chunk can be understood
 * in isolation. The format is:
 *   Line 1: file: <filePath>
 *   Line 2: <ctagsKind>: <fullyQualifiedName>    (only if inside a container)
 *   Line 3: signature: <signature>               (only for non-first chunks
 *                                                  of function/method/prototype)
 *   Blank line separator
 *
 * @param filePath - Absolute path of the source file
 * @param container - Container metadata, or undefined if the chunk is outside any container
 * @param isFirstChunk - Whether this is the first chunk of the container
 * @returns The prefix string (including trailing blank line)
 */
function computeChunkPrefix(
    filePath: string,
    container?: { kind: string; qualifiedName: string; signature?: string },
    isFirstChunk: boolean = true,
): string {
    let prefix = `file: ${filePath}`;

    if (container) {
        prefix += `\n${container.kind}: ${container.qualifiedName}`;

        if (!isFirstChunk && SIGNATURE_KINDS.has(container.kind) && container.signature) {
            prefix += `\nsignature: ${container.signature}`;
        }
    }

    return prefix + '\n\n';
}

/**
 * Prepend a context prefix to each chunk's text.
 *
 * @param chunks - Array of chunks to modify in place
 * @param filePath - Absolute path of the source file
 * @param container - Container metadata, or undefined if chunks are outside any container
 */
function prependPrefixes(
    chunks: Chunk[],
    filePath: string,
    container?: { kind: string; qualifiedName: string; signature?: string },
): void {
    for (let i = 0; i < chunks.length; i++) {
        const isFirstChunk = i === 0;
        const prefix = computeChunkPrefix(filePath, container, isFirstChunk);
        chunks[i].text = prefix + chunks[i].text;
    }
}

/**
 * Compute text chunks for a C++ file using ctags container boundaries.
 * Containers (functions, classes, etc.) are kept together when possible.
 * Gaps between containers are chunked separately.
 *
 * @param input - Input containing file path and ctags path
 * @param lines - Array of all lines in the file
 * @param tags - Array of container tag entries parsed from ctags output
 * @returns Output with extracted chunks
 */
function computeChunksWithCtags(
    input: ComputeChunksInput,
    lines: string[],
    parsedTags: ParsedTags,
): ComputeChunksOutput {
    const { tags, firstTagLine } = parsedTags;
    const totalLines = lines.length;
    const topLevelRanges = findTopLevelRanges(tags);
    expandRangesToIncludePrecedingLines(topLevelRanges, lines);
    const chunks: Chunk[] = [];

    let cursor = 1; // 1-based current line

    // Skip preamble (copyright, includes, etc.) before the first tag in
    // the file when that tag falls at or before the first container range.
    if (firstTagLine !== undefined && topLevelRanges.length > 0 &&
        firstTagLine <= topLevelRanges[0].startLine) {
        cursor = firstTagLine;
    }

    for (const range of topLevelRanges) {
        // Chunk the gap before this container (includes, forward decls, etc.)
        if (cursor < range.startLine) {
            const gapChunks = splitIntoChunks(lines, cursor, range.startLine - 1, MAX_CHUNK_LINES);
            prependPrefixes(gapChunks, input.filePath);
            chunks.push(...gapChunks);
        }

        // Chunk the container itself
        const containerChunks = splitIntoChunks(lines, range.startLine, range.endLine, MAX_CHUNK_LINES);
        prependPrefixes(containerChunks, input.filePath, range);
        chunks.push(...containerChunks);

        cursor = range.endLine + 1;
    }

    // Chunk any trailing lines after the last container
    if (cursor <= totalLines) {
        const trailingChunks = splitIntoChunks(lines, cursor, totalLines, MAX_CHUNK_LINES);
        prependPrefixes(trailingChunks, input.filePath);
        chunks.push(...trailingChunks);
    }

    return {
        type: 'computeChunks',
        filePath: input.filePath,
        chunks,
    };
}

/**
 * Compute text chunks for a non-C++ file using simple fixed-size splitting.
 * No structural awareness – just splits into consecutive line groups.
 *
 * @param input - Input containing file path
 * @param lines - Array of all lines in the file
 * @returns Output with extracted chunks
 */
function computeChunksSimple(
    input: ComputeChunksInput,
    lines: string[],
): ComputeChunksOutput {
    const chunks = splitIntoChunks(lines, 1, lines.length, MAX_CHUNK_LINES);
    prependPrefixes(chunks, input.filePath);

    return {
        type: 'computeChunks',
        filePath: input.filePath,
        chunks,
    };
}

/**
 * Compute text chunks for a file.
 * For C/C++ files the ctags file is parsed to produce structure-aware chunks.
 * For all other files a simple fixed-size line split is used.
 *
 * @param input - Input containing file path and ctags path
 * @returns Output with extracted chunks
 */
export async function computeChunks(input: ComputeChunksInput): Promise<ComputeChunksOutput> {
    try {
        const contentBuffer = await fs.promises.readFile(input.filePath);
        const content = contentBuffer.toString('utf8');
        const lines = content.split('\n');

        const ext = path.extname(input.filePath).toLowerCase();

        if (CPP_EXTENSIONS.has(ext)) {
            // Try to read the ctags file; fall back to simple chunking if unavailable
            try {
                const tagsContent = await fs.promises.readFile(input.ctagsPath, 'utf8');
                const parsedTags = parseContainerTags(tagsContent);

                if (parsedTags.tags.length > 0) {
                    return computeChunksWithCtags(input, lines, parsedTags);
                }
            } catch {
                // Tags file missing or unreadable – fall through to simple chunking
            }
        }

        return computeChunksSimple(input, lines);
    } catch (error) {
        return {
            type: 'computeChunks',
            filePath: input.filePath,
            chunks: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
