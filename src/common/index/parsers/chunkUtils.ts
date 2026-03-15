// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Shared chunking utilities for splitting source files into text chunks
 * suitable for embedding search.
 */

import type { Chunk } from '../types';

// ── Constants ───────────────────────────────────────────────────────────────

/** Approximate number of tokens per chunk for embedding. */
export const MAX_CHUNK_TOKENS = 1024;

/** Approximate character budget per chunk (~3.5 chars/token). */
export const MAX_CHUNK_CHARS = Math.floor(MAX_CHUNK_TOKENS * 3.5);

/** Number of overlapping lines between consecutive chunks (~10%). */
export const OVERLAP_LINES = 8;

/** Minimum character length for a chunk to be kept (filters trivial fragments). */
export const MIN_CHUNK_CHARS = 75;

/**
 * Optional predicate that parsers can supply to filter out
 * language-specific boilerplate chunks (e.g. closing braces,
 * preprocessor guards). Receives the trimmed chunk text.
 * Return `true` to discard the chunk.
 */
export type BoilerplateFilter = (trimmedText: string) => boolean;

// ── Low-level splitting ─────────────────────────────────────────────────────

/**
 * Scan forward from `start`, accumulating character counts (including
 * newline separators), and return the 0-based exclusive end line where
 * the next line would exceed `maxChars`. At least one line is always
 * included so that a single oversized line doesn't cause an infinite loop.
 */
function findChunkEndByBudget(
    lines: readonly string[],
    start: number,
    end: number,
    maxChars: number,
): number {
    let charCount = 0;
    for (let i = start; i < end; i++) {
        charCount += lines[i].length + 1; // +1 for '\n' separator
        if (charCount > maxChars) {
            return Math.max(i, start + 1); // always include at least one line
        }
    }
    return end;
}

/**
 * Split a line range into token-budget-sized chunks (≈ {@link MAX_CHUNK_TOKENS}
 * tokens at ~3.5 chars/token) with {@link OVERLAP_LINES} overlap.
 * Chunks that are empty or below {@link MIN_CHUNK_CHARS} are discarded.
 * An optional `isBoilerplate` predicate lets parsers filter out
 * language-specific boilerplate chunks. No context prefix is applied —
 * callers are responsible for prepending any prefixes they need.
 *
 * The SHA-256 digest is computed on the raw text (before any prefix).
 *
 * All positions use 0-based, end-exclusive conventions (matching
 * tree-sitter / VS Code). The returned {@link Chunk} objects also use
 * 0-based end-exclusive line numbers — callers that need to satisfy the
 * public 1-based inclusive {@link Chunk} contract should convert
 * before returning.
 *
 * @param lines         - All lines in the file (0-based array)
 * @param startLine     - 0-based start line (inclusive)
 * @param endLine       - 0-based end line (exclusive)
 * @param isBoilerplate - Optional predicate receiving trimmed chunk text;
 *                        return `true` to discard the chunk
 * @returns Array of {@link Chunk} objects with 0-based line numbers
 */
export function splitIntoChunks(
    lines: readonly string[],
    startLine: number,
    endLine: number,
    isBoilerplate?: BoilerplateFilter,
): Chunk[] {
    const chunks: Chunk[] = [];
    let current = startLine;

    while (current < endLine) {
        const chunkEnd = findChunkEndByBudget(lines, current, endLine, MAX_CHUNK_CHARS);

        // Trim leading and trailing blank lines from the chunk range.
        let trimStart = current;
        while (trimStart < chunkEnd && !lines[trimStart].trim()) {
            trimStart++;
        }
        let trimEnd = chunkEnd;
        while (trimEnd > trimStart && !lines[trimEnd - 1].trim()) {
            trimEnd--;
        }

        const text = lines.slice(trimStart, trimEnd).join('\n');

        const trimmed = text.trim();
        if (trimmed && trimmed.length >= MIN_CHUNK_CHARS &&
            !(isBoilerplate && isBoilerplate(trimmed))) {
            chunks.push({ startLine: trimStart, endLine: trimEnd, text, sha256: '' });
        }

        // If this chunk reached the end, we're done
        if (chunkEnd >= endLine) {
            break;
        }

        current = Math.max(chunkEnd - OVERLAP_LINES, current + 1);
    }

    return chunks;
}

/**
 * Convert chunk line numbers from 0-based end-exclusive (internal)
 * to 1-based end-inclusive (public {@link Chunk} contract).
 *
 * Since 0-based exclusive end == 1-based inclusive end, only
 * `startLine` needs adjustment (`+1`).
 */
export function chunksToOneBased(chunks: Chunk[]): void {
    // Single-pass: filter out degenerate chunks (empty or inverted
    // 0-based exclusive ranges) and convert in one traversal.
    let write = 0;
    for (let read = 0; read < chunks.length; read++) {
        const chunk = chunks[read];
        if (chunk.endLine > chunk.startLine) {
            chunk.startLine += 1;
            // endLine: 0-based exclusive N == 1-based inclusive N (no change)
            chunks[write++] = chunk;
        }
    }
    chunks.length = write;
}
