// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Shared chunking utilities for splitting source files into text chunks
 * suitable for embedding search.
 *
 * The main entry point is {@link splitIntoChunks}, which takes parser-
 * determined {@link ChunkRange}s and produces token-budget-compliant
 * {@link Chunk}s using exact tokenization via the llama-server
 * `/tokenize` endpoint.
 */

import * as http from 'http';
import type { Chunk, ChunkingConfig } from '../types';
import { SplitLineView } from './splitLineView';

// ── Token-per-character ratio assumption ────────────────────────────────────
//
// This code assumes a worst-case ratio of 1.0 tokens per JS string
// character (string.length unit). While some Unicode sequences can
// exceed 1.0, they require many consecutive occurrences to cause a
// budget violation.
//
// Tokens/character approxations. Tested with Qwen3-Embedding 0.6B
// via the llama.cpp /tokenize endpoint:
//
//   Content                  chars(.length)  tokens  ratio
//   ───────────────────────  ──────────────  ──────  ─────
//   ASCII code                    varies   varies   almost always below 1.0
//   Single CJK char                    1        1   1.00
//   CJK sentence (Chinese)            24       15   0.63
//   CJK sentence (Japanese)           23       14   0.61
//   CJK sentence (Korean)             28       22   0.79
//   Long CJK prefix                   93       47   0.51
//   Mixed CJK + ASCII                 27       13   0.48
//   Common emoji                       2        1   0.50
//   Emoji ZWJ sequence                 5        4   0.80
//   Emoji family ZWJ                  11       10   0.91
//   Emoji keycap                       3        5   1.67  *
//   Rare CJK ext-B                    10       15   1.50  *
//
//   * These exceed 1.0 but require many consecutive characters to
//     cause a real budget violation. Keycap sequences and CJK
//     Extension-B characters should not appear in text often enough
//     in practice to trigger a token budget violation.
//
// The 1.0 ratio assumption is only used to set static limits:
// MAX_LINE_LENGTH (virtual line cap) and getPrefixBudget (prefix
// character cap). These ensure that a prefix plus one content line
// can usually fit within maxCharacters. Actual token counts for
// chunk sizing are retrieved from the embedding model via the
// llama-server /tokenize endpoint — the algorithm does not rely on
// the 1.0 tokens/char ratio assumption for runtime decisions.
//
// Algorithm overview:
//
// 1. Parsers supply ChunkRanges (line ranges with context prefixes).
//    splitIntoChunks estimates initial chunk boundaries using a
//    per-line tokens/char ratio, then batch-tokenizes all chunks via
//    /tokenize. Over-budget chunks trigger ratio corrections and
//    re-splits until every chunk is within the maxTokens budget.
//
// 2. Chunks are sized to maximize both token count and character
//    count (up to maxTokens and maxCharacters respectively) so each
//    chunk carries as much information as possible for embedding.
//
// 3. If a chunk cannot be shrunk below one virtual line and is still
//    over budget, it is silently dropped. This guarantees termination
//    in all cases, including pathological token densities or
//    oversized prefixes.

// ── Constants ───────────────────────────────────────────────────────────────

/** Maxium virtual line length of each line in the source file before chunking. */
export const MAX_LINE_LENGTH = 150;

/** Number of overlapping lines between consecutive chunks. */
export const OVERLAP_LINES = 10;

/** Minimum character length for a chunk to be kept (filters trivial fragments). */
export const MIN_CHUNK_CHARS = 75;

/** Fast check for non-whitespace content. */
const NON_WHITESPACE_RE = /\S/;

// ── Prefix budget ───────────────────────────────────────────────────────────

/**
 * Returns the maximum number of characters a parser may use for a
 * chunk prefix (either {@link ChunkRange.primaryPrefix} or
 * {@link ChunkRange.secondaryPrefix}).
 *
 * The budget is `maxCharacters - MAX_LINE_LENGTH` because every chunk
 * must contain at least one virtual line (up to {@link MAX_LINE_LENGTH}
 * chars). The remaining character space is available for the prefix.
 *
 * Parsers **must** ensure that both prefixes in every {@link ChunkRange}
 * are within this budget. If a prefix exceeds the budget,
 * {@link splitIntoChunks} may not converge.
 */
export function getPrefixBudget(maxCharacters: number): number {
    return maxCharacters - MAX_LINE_LENGTH;
}

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * A parser-determined range of lines to be chunked, with context prefixes.
 */
export interface ChunkRange {
    /** 0-based start line of the chunk range (inclusive) */
    startLine: number;
    /** 0-based end line of the chunk range (exclusive) */
    endLine: number;
    /** The prefix to use for the first chunk in this range */
    primaryPrefix: string;
    /** The prefix to use for additional chunks if the range is split */
    secondaryPrefix: string;
}

/**
 * Optional predicate that parsers can supply to filter out
 * language-specific boilerplate chunks (e.g. closing braces,
 * preprocessor guards). Receives the trimmed chunk text.
 * Return `true` to discard the chunk.
 */
export type BoilerplateFilter = (trimmedText: string) => boolean;

// ── Tokenization ────────────────────────────────────────────────────────────

/** Keep-alive agent for reusing TCP connections to the tokenize server. */
const tokenizeAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 10,
    timeout: 10000,
});

/**
 * Get the token count for a single string via the llama-server
 * /tokenize endpoint. Returns -1 on any error.
 *
 * @param content - The text to tokenize
 * @param hostname - Server hostname
 * @param port - Server port
 */
function getTokenCount(content: string, hostname: string, port: number): Promise<number> {
    return new Promise((resolve) => {
        const data = JSON.stringify({ content });
        const req = http.request({
            hostname,
            port,
            path: '/tokenize',
            method: 'POST',
            agent: tokenizeAgent,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            },
        }, res => {
            let body = '';
            res.on('data', (c: string) => body += c);
            res.on('end', () => {
                try {
                    const r = JSON.parse(body);
                    resolve(r.tokens.length);
                } catch {
                    resolve(-1);
                }
            });
        });
        req.on('error', () => resolve(-1));
        req.setTimeout(10000, () => {
            req.destroy();
            resolve(-1);
        });
        req.end(data);
    });
}

/**
 * Get token counts for multiple strings in parallel.
 * Each element is the token count for the corresponding input,
 * or -1 if that request failed.
 *
 * @param contents - Array of text strings to tokenize
 * @param hostname - Server hostname
 * @param port - Server port
 * @returns Array of token counts, one per input string
 */
export function getTokenCounts(contents: string[], hostname: string, port: number): Promise<number[]> {
    if (_getTokenCountsMock) return _getTokenCountsMock(contents, hostname, port);
    return Promise.all(contents.map(c => getTokenCount(c, hostname, port)));
}

// ── Initial split (single range) ────────────────────────────────────────────

/**
 * Scan forward from `start`, accumulating estimated token counts using
 * per-line tokens/char ratios. Returns the 0-based exclusive end line
 * where adding the next line would exceed the token budget.
 * At least one line is always included.
 */
function findChunkEndByTokenEstimate(
    lines: SplitLineView,
    start: number,
    end: number,
    maxTokens: number,
    prefixTokenEstimate: number,
    tokensPerCharByLine: Float32Array,
): number {
    let estimatedTokens = prefixTokenEstimate;
    for (let i = start; i < end; i++) {
        // +1 accounts for the newline char added between lines
        estimatedTokens += (lines.getLineLength(i) + 1) * tokensPerCharByLine[i];
        if (estimatedTokens > maxTokens) {
            return Math.max(i, start + 1);
        }
    }
    return end;
}

/**
 * Scan backward from `end`, accumulating estimated token counts using
 * per-line tokens/char ratios. Returns the 0-based inclusive start line
 * where adding the previous line would exceed the token budget.
 * At least one line is always included.
 */
function findChunkStartByTokenEstimate(
    lines: SplitLineView,
    start: number,
    end: number,
    maxTokens: number,
    prefixTokenEstimate: number,
    tokensPerCharByLine: Float32Array,
): number {
    let estimatedTokens = prefixTokenEstimate;
    for (let i = end - 1; i >= start; i--) {
        // +1 accounts for the newline char added between lines
        estimatedTokens += (lines.getLineLength(i) + 1) * tokensPerCharByLine[i];
        if (estimatedTokens > maxTokens) {
            return Math.min(i + 1, end - 1);
        }
    }
    return start;
}

/**
 * Split a single {@link ChunkRange} into chunks using greedy fill
 * from the start and greedy reverse-fill for the last chunk.
 *
 * Operates on virtual line indices from the {@link SplitLineView}.
 * The caller is responsible for verifying token counts afterward.
 *
 * @param lines - Line view over the source file
 * @param range - Chunk range with line indices in startLine/endLine
 * @param maxTokens - Token budget per chunk
 * @param tokensPerCharByLine - Per-line tokens/char ratio estimates
 * @param isBoilerplate - Optional boilerplate filter
 * @returns Array of chunks for this range
 */
function splitChunkRange(
    range: ChunkRange,
    lines: SplitLineView,
    maxTokens: number,
    tokensPerCharByLine: Float32Array,
    isBoilerplate?: BoilerplateFilter,
): Chunk[] {
    const { startLine, endLine, primaryPrefix, secondaryPrefix } = range;
    if (startLine >= endLine) return [];

    // Greedy-fill from start, building Chunk objects directly.
    const chunks: Chunk[] = [];
    let current = startLine;

    while (current < endLine) {
        // Skip any leading blank lines
        while (current < endLine && !NON_WHITESPACE_RE.test(lines.getLine(current))) {
            current++;
        }
        if (current >= endLine) break;

        // Compute prefix token estimate using the ratio at the chunk's actual
        // start line, so the prefix charge reflects the local density rather
        // than using a line which may not have been included in a chunk.
        const prefixLen = chunks.length === 0 ? primaryPrefix.length : secondaryPrefix.length;
        const prefixTokens = prefixLen * tokensPerCharByLine[current];
        const chunkEnd = findChunkEndByTokenEstimate(
            lines, current, endLine, maxTokens, prefixTokens, tokensPerCharByLine,
        );

        // Trim trailing blank lines from the chunk so the stored
        // bounds only cover content lines.
        let trimmedEnd = chunkEnd;
        while (trimmedEnd > current && !NON_WHITESPACE_RE.test(lines.getLine(trimmedEnd - 1))) {
            trimmedEnd--;
        }

        const contentText = lines.getText(current, trimmedEnd);
        if (contentText && contentText.length >= MIN_CHUNK_CHARS
            && !(isBoilerplate && isBoilerplate(contentText))) {
            const prefix = chunks.length === 0 ? primaryPrefix : secondaryPrefix;
            chunks.push({
                startLine: current,
                endLine: trimmedEnd,
                text: prefix + contentText,
                sha256: '',
            });
        }

        // Loop control uses the untrimmed chunkEnd
        // for overlap and end-of-range detection.
        if (chunkEnd >= endLine) break;

        // Advance by at least 1 line to guarantee forward progress.
        // This can happen when a chunk line length is less than
        // OVERLAP_LINES, which makes chunkEnd - OVERLAP_LINES ≤ current.
        current = Math.max(chunkEnd - OVERLAP_LINES, current + 1);
    }

    // Reverse-fill last chunk if there are multiple chunks
    if (chunks.length > 1) {
        // Trim trailing blanks from the range end
        let revEnd = endLine;
        while (revEnd > startLine && !NON_WHITESPACE_RE.test(lines.getLine(revEnd - 1))) {
            revEnd--;
        }
        if (revEnd > startLine) {
            const reversePrefixTokens = secondaryPrefix.length * tokensPerCharByLine[revEnd - 1];
            const lastChunkStart = findChunkStartByTokenEstimate(
                lines, startLine, endLine, maxTokens, reversePrefixTokens, tokensPerCharByLine,
            );

            // Skip leading blanks on the reverse-fill start
            let trimmedLastStart = lastChunkStart;
            while (trimmedLastStart < endLine && !NON_WHITESPACE_RE.test(lines.getLine(trimmedLastStart))) {
                trimmedLastStart++;
            }

            // Dedup: if the reverse-fill fully contains the
            // previous chunk, drop the previous chunk
            const prevChunk = chunks[chunks.length - 2];
            if (trimmedLastStart <= prevChunk.startLine) {
                chunks[chunks.length - 2] = chunks[chunks.length - 1];
                chunks.length--;
            }

            // Update the last chunk with the reverse-fill range
            const last = chunks[chunks.length - 1];
            last.startLine = trimmedLastStart;
            last.endLine = revEnd;

            const contentText = lines.getText(trimmedLastStart, revEnd);
            if (contentText && contentText.length >= MIN_CHUNK_CHARS
                && !(isBoilerplate && isBoilerplate(contentText))) {
                const prefix = chunks.length === 1 ? primaryPrefix : secondaryPrefix;
                last.text = prefix + contentText;
            }
        }
    }

    return chunks;
}

// ── Main orchestrator ───────────────────────────────────────────────────────

/**
 * Split source file lines into token-budget-compliant chunks using
 * parser-determined ranges and exact tokenization.
 *
 * The algorithm:
 * 1. Estimate chunk boundaries using a token-per-character heuristic.
 * 2. Tokenize all chunks in one batch via the llama-server.
 * 3. For any over-budget chunks, refine per-line ratio estimates and
 *    re-split the affected ranges. Repeat until all chunks are within
 *    budget.
 *
 * Chunks use greedy fill from the start of each range with
 * {@link OVERLAP_LINES} overlap, plus a reverse-fill last chunk to
 * maximize information per chunk.
 *
 * All positions use 0-based, end-exclusive conventions.
 *
 * **Precondition:** Every prefix in `chunkRanges` must be at most
 * {@link getPrefixBudget | getPrefixBudget(config.maxCharacters)} characters
 * long. Violating this may cause the tokenization loop to never
 * converge.
 *
 * @param lines - All lines in the source file
 * @param chunkRanges - Parser-determined ranges with prefixes
 * @param config - Chunking config
 * @param isBoilerplate - Optional boilerplate filter
 * @returns One Chunk[] per input ChunkRange, in the same order
 * @throws If the tokenize server is unreachable or returns errors
 */
export async function splitIntoChunks(
    lines: readonly string[],
    chunkRanges: ChunkRange[],
    config: ChunkingConfig,
    isBoilerplate?: BoilerplateFilter,
): Promise<Chunk[][]> {
    if (chunkRanges.length === 0) return [];

    const { maxTokens, maxCharacters, tokenizerHostName, tokenizerPort } = config;

    if (maxCharacters < MAX_LINE_LENGTH) {
        // SplitLineView caps virtual lines at MAX_LINE_LENGTH chars. If
        // maxCharacters is smaller, the "at least one line is included in a
        // chunk" guarantee could violate the character budget.
        throw new Error(
            `maxCharacters (${maxCharacters}) must be >= MAX_LINE_LENGTH (${MAX_LINE_LENGTH})`
        );
    }

    // Normalize long lines into virtual lines so that all splitting
    // logic operates on line boundaries without special-casing.
    const lineView = new SplitLineView(lines, MAX_LINE_LENGTH);

    // Per-line tokens/char ratio estimates. The initial ratio is chosen so
    // that limiting estimated tokens to maxTokens implicitly limits total
    // characters to maxCharacters. The Math.max guard in the correction
    // loop ensures this ratio never decreases, preserving the guarantee.
    const initialTokensPerChar = maxTokens / maxCharacters;
    const tokensPerCharByLine = new Float32Array(lineView.lineCount);
    tokensPerCharByLine.fill(initialTokensPerChar);

    // Convert ChunkRange source lines to virtual indices if needed.
    const ranges: ChunkRange[] = lineView.isIdentity
        ? chunkRanges
        : chunkRanges.map(range => {
            const [startLine, endLine] = lineView.getVirtualRange(range.startLine, range.endLine);
            return {
                startLine,
                endLine,
                primaryPrefix: range.primaryPrefix,
                secondaryPrefix: range.secondaryPrefix
            };
        });

    // Phase 1: Initial split for all ranges
    const result: Chunk[][] = ranges.map(range =>
        splitChunkRange(range, lineView, maxTokens, tokensPerCharByLine, isBoilerplate),
    );

    // Reusable flat arrays for collecting chunks to tokenize.
    // Reset each iteration via .length = 0 to avoid re-allocation.
    const texts: string[] = [];
    const chunkRefs: Chunk[] = [];
    const rangeIdxForChunks: number[] = [];
    const rangesToProcess: number[] = [];

    // First pass: collect all chunks for tokenization
    for (let r = 0; r < result.length; r++) {
        for (const chunk of result[r]) {
            texts.push(chunk.text);
            chunkRefs.push(chunk);
            rangeIdxForChunks.push(r);
        }
    }

    // Iterative tokenization and correction loop
    while (texts.length > 0) {
        // Batch tokenize
        const tokenCounts = await getTokenCounts(
            texts, tokenizerHostName, tokenizerPort);

        // Find over-budget chunks, update ratios, and collect affected ranges.
        rangesToProcess.length = 0;

        for (let i = 0; i < tokenCounts.length; i++) {
            if (tokenCounts[i] === -1) {
                throw new Error('Tokenization failed: server returned an error');
            }
            if (tokenCounts[i] > maxTokens) {
                const chunk = chunkRefs[i];
                const r = rangeIdxForChunks[i];

                // A single-line chunk cannot be shrunk further. Drop it
                // silently to guarantee the loop terminates.
                if (chunk.endLine - chunk.startLine <= 1) {
                    result[r] = result[r].filter(c => c !== chunk);
                    continue;
                }

                // Update per-line ratio estimate for this over-budget chunk.
                // Use max to ensure ratios only increase (more conservative),
                // preventing overlap regions from being lowered by a less
                // dense adjacent chunk and causing an extra iteration.
                const tokensPerChar = tokenCounts[i] / texts[i].length;
                for (let j = chunk.startLine; j < chunk.endLine; j++) {
                    tokensPerCharByLine[j] = Math.max(tokensPerCharByLine[j], tokensPerChar);
                }

                // Dedup via last-value check since chunks are grouped by range.
                if (rangesToProcess[rangesToProcess.length - 1] !== r) {
                    rangesToProcess.push(r);
                }
            }
        }

        // All chunks are within budget — done
        if (rangesToProcess.length === 0) break;

        // Re-split affected ranges and collect their new chunks
        texts.length = 0;
        chunkRefs.length = 0;
        rangeIdxForChunks.length = 0;

        for (const rangeIdx of rangesToProcess) {
            result[rangeIdx] = splitChunkRange(
                ranges[rangeIdx], lineView,
                maxTokens, tokensPerCharByLine, isBoilerplate,
            );
            for (const chunk of result[rangeIdx]) {
                texts.push(chunk.text);
                chunkRefs.push(chunk);
                rangeIdxForChunks.push(rangeIdx);
            }
        }
    }

    // Convert to public Chunk contract (1-based inclusive) and
    // virtual → source line numbers in a single pass.
    for (const chunks of result) {
        for (const chunk of chunks) {
            if (!lineView.isIdentity) {
                const [srcStart, srcEnd] = lineView.getSourceRange(chunk.startLine, chunk.endLine);
                chunk.startLine = srcStart;
                chunk.endLine = srcEnd;
            }
            chunk.startLine += 1;
        }
    }

    return result;
}

// ── Test-only exports ───────────────────────────────────────────────────────
// These are internal helpers exported solely for unit testing.
// Do not use outside of test files.

/** @internal Test-only: set to override getTokenCounts in unit tests. */
let _getTokenCountsMock: ((contents: string[], hostname: string, port: number) => Promise<number[]>) | null = null;

/** @internal Test-only: set or clear the getTokenCounts mock. */
export function _setGetTokenCountsMock(
    mock: ((contents: string[], hostname: string, port: number) => Promise<number[]>) | null,
): void {
    _getTokenCountsMock = mock;
}

export {
    findChunkEndByTokenEstimate as _findChunkEndByTokenEstimate,
    findChunkStartByTokenEstimate as _findChunkStartByTokenEstimate,
    splitChunkRange as _splitChunkRange,
};
