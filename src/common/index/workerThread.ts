// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Worker thread script for parallel content search and indexing.
 * This file runs in a separate worker thread and performs file operations.
 *
 * IMPORTANT: This module must be standalone with no runtime imports from other
 * project files. Type-only imports are safe as they are erased at compile time.
 */

import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { IndexStatus } from './types';
import type {
    SearchInput,
    LineResult,
    SearchOutput,
    IndexInput,
    IndexOutput,
    Chunk,
    ComputeChunksInput,
    ComputeChunksOutput,
    SearchEmbeddingsInput,
    SearchEmbeddingsOutput,
} from './types';

const execFileAsync = promisify(execFile);

// Global error handlers to prevent worker crashes
process.on('uncaughtException', (error) => {
    console.error('Worker uncaught exception:', error);
});
process.on('unhandledRejection', (reason) => {
    console.error('Worker unhandled rejection:', reason);
});

/**
 * Extract the full line text containing a match position.
 * Uses indexOf/lastIndexOf for efficiency.
 *
 * @param content - Full file content
 * @param matchIndex - Position of the match in the content
 * @returns Line text without trailing newline
 */
function getLineText(content: string, matchIndex: number): string {
    // Find line start (character after previous newline, or 0)
    const lineStart = content.lastIndexOf('\n', matchIndex - 1) + 1;

    // Find line end (next newline, or end of content)
    let lineEnd = content.indexOf('\n', matchIndex);
    if (lineEnd === -1) {
        lineEnd = content.length;
    }

    // Extract and handle Windows line endings (\r\n)
    let text = content.substring(lineStart, lineEnd);
    if (text.endsWith('\r')) {
        text = text.slice(0, -1);
    }

    return text;
}

/**
 * Search file content for matches using the provided regex pattern.
 * Uses progressive line counting - only computes line numbers for matches.
 *
 * @param content - Full file content to search
 * @param regexPattern - Regex pattern string to search for
 * @returns Array of results with line numbers and text
 */
function searchFileWithSingleRegex(content: string, regexPattern: string): LineResult[] {
    const regex = new RegExp(regexPattern, 'gim'); // g=global, i=case-insensitive, m=multiline

    const results: LineResult[] = [];
    const seenLines = new Set<number>(); // Avoid duplicate lines

    // Progressive line counting - only computed when matches found
    let lastPos = 0;
    let currentLine = 1;

    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
        // Count newlines from lastPos to match position using indexOf
        let pos = lastPos;
        while (pos < match.index) {
            const nextNewline = content.indexOf('\n', pos);
            if (nextNewline === -1 || nextNewline >= match.index) {
                break;
            }
            currentLine++;
            pos = nextNewline + 1;
        }
        lastPos = pos;

        if (!seenLines.has(currentLine)) {
            seenLines.add(currentLine);
            const text = getLineText(content, match.index);
            results.push({ line: currentLine, text });
        }
    }

    return results;
}

/**
 * Search a file for matches using AND semantics across multiple regex patterns.
 * All patterns must match somewhere in the file for results to be returned.
 *
 * @param input - Search input containing file path and regex patterns array
 * @returns Search output with results or error
 */
async function searchFile(input: SearchInput): Promise<SearchOutput> {
    try {
        const content = await fs.promises.readFile(input.filePath, 'utf8');

        // If no patterns provided, return empty results
        if (!input.regexPatterns || input.regexPatterns.length === 0) {
            return { filePath: input.filePath, results: [] };
        }

        // Collect results for each pattern
        const allPatternResults: LineResult[][] = [];

        for (const pattern of input.regexPatterns) {
            const patternResults = searchFileWithSingleRegex(content, pattern);

            // If any pattern has no matches, the file doesn't match (AND semantics)
            if (patternResults.length === 0) {
                return { filePath: input.filePath, results: [] };
            }

            allPatternResults.push(patternResults);
        }

        // All patterns matched - merge results and deduplicate by line number
        const seenLines = new Set<number>();
        const mergedResults: LineResult[] = [];

        for (const patternResults of allPatternResults) {
            for (const result of patternResults) {
                if (!seenLines.has(result.line)) {
                    seenLines.add(result.line);
                    mergedResults.push(result);
                }
            }
        }

        // Sort by line number
        mergedResults.sort((a, b) => a.line - b.line);

        return { filePath: input.filePath, results: mergedResults };
    } catch (error) {
        return {
            filePath: input.filePath,
            results: [],
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Index a file using ctags.
 * Runs ctags to generate a JSON tags file for the input file.
 *
 * @param input - Index input containing file path, ctags path, and output tags path
 * @returns Index output with tags path or error
 */
async function indexFile(input: IndexInput): Promise<IndexOutput> {
    try {
        const sourceMtime = fs.statSync(input.filePath).mtimeMs;
        const tagsMtime = fs.statSync(input.tagsPath).mtimeMs;
        if (tagsMtime >= sourceMtime) {
            // The tags file is up-to-date, skip indexing
            return {
                type: 'index',
                status: IndexStatus.Skipped,
                filePath: input.filePath,
                tagsPath: input.tagsPath,
            };
        }
    } catch {
        // Tags file doesn't exist or other error - proceed with indexing
    }

    try {
        // Read source file and compute SHA256 hash
        const sourceContent = fs.readFileSync(input.filePath);
        const hash = crypto.createHash('sha256').update(sourceContent).digest('hex');

        if (fs.existsSync(input.tagsPath)) {
            // Check the SHA256 hash at the end of the tags file to see if
            // it matches the current source content. The last line is exactly:
            // {"_type": "sha256", "hash": "<64 hex chars>"}\n  (95 bytes)
            const HASH_LINE_LEN = 96;
            const HASH_OFFSET = 29; // offset to the start of the 64-char hex hash
            const fileSize = fs.statSync(input.tagsPath).size;
            if (fileSize >= HASH_LINE_LEN) {
                const fd = fs.openSync(input.tagsPath, 'r');
                const buf = Buffer.alloc(HASH_LINE_LEN);
                fs.readSync(fd, buf, 0, HASH_LINE_LEN, fileSize - HASH_LINE_LEN);
                fs.closeSync(fd);
                const storedHash = buf.toString('utf8').substring(HASH_OFFSET, HASH_OFFSET + 64);
                if (storedHash === hash) {
                    return {
                        type: 'index',
                        status: IndexStatus.Skipped,
                        filePath: input.filePath,
                        tagsPath: input.tagsPath,
                    };
                }
            }

            // Delete existing tags file - ctags refuses to overwrite it.
            // JSON-format tags files because they don't look like traditional tags
            // TODO: remove this when using ctags version that supports force overwrites.
            try {
                fs.unlinkSync(input.tagsPath);
            } catch (err) {
                console.error(`Failed to delete ${input.tagsPath}:`, err);
            }
        }

        // Run ctags with JSON output format
        // --fields=+neZKS: line number, end line, scope with kind, kind full name, signature
        // --kinds-all='*': include all symbol kinds
        // --output-format=json: structured JSON output
        await execFileAsync(input.ctagsPath, [
            '--output-format=json',
            '--fields=+cneNZKS',
            '--kinds-all=*',
            '-o', input.tagsPath,
            input.filePath
        ], { timeout: 3000 });

        // Append hash line at the end of the tags file
        if (fs.existsSync(input.tagsPath)) {
            // If modifying this line format, also update the
            // HASH_LINE_LEN and HASH_OFFSET constants above
            // and update the same values in FileIndex.isValid().
            fs.appendFileSync(input.tagsPath, `{"_type": "sha256", "hash": "${hash}"}\n`);
        } else {
            return {
                type: 'index',
                status: IndexStatus.Failed,
                filePath: input.filePath,
                tagsPath: null,
                error: 'ctags did not produce an output file in the allotted time'
            };
        }

        return {
            type: 'index',
            status: IndexStatus.Indexed,
            filePath: input.filePath,
            tagsPath: input.tagsPath,
        };
    } catch (error) {
        return {
            type: 'index',
            status: IndexStatus.Failed,
            filePath: input.filePath,
            tagsPath: null,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

// ── Chunking constants and helpers ──────────────────────────────────────────

/** Maximum number of lines per chunk for embedding */
const MAX_CHUNK_LINES = 150;

/** Number of overlapping lines between consecutive chunks (~20% of chunk size) */
const CHUNK_OVERLAP_LINES = 15;

/** Minimum character length for a chunk to be kept (filters out trivial chunks) */
const MIN_CHUNK_CHARS = 75;

/**
 * Matches lines that are purely boilerplate: closing braces (with optional
 * namespace comments), #endif guards, and #pragma once.
 */
const BOILERPLATE_LINE = /^\s*(\}[;,]?\s*(\/\/.*)?|#endif\b.*|#pragma\s+once\s*)$/;

/**
 * Check whether a chunk consists entirely of boilerplate lines
 * (closing braces, namespace-closing comments, #endif guards, blank lines).
 * These chunks add noise to embedding search results without providing
 * meaningful content.
 *
 * @param trimmedText - The trimmed (no leading/trailing whitespace) chunk text
 * @returns true if every non-empty line matches a boilerplate pattern
 */
function isBoilerplateChunk(trimmedText: string): boolean {
    if (trimmedText.length > 175) {
        return false;
    }
    return trimmedText.split('\n').every(
        line => !line.trim() || BOILERPLATE_LINE.test(line),
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

/**
 * Parse a ctags JSON file and return container entries that have an end line.
 *
 * @param tagsContent - Raw content of the ctags JSON file
 * @returns Array of tag entries with line ranges
 */
function parseContainerTags(tagsContent: string): TagEntry[] {
    const tags: TagEntry[] = [];

    for (const line of tagsContent.split('\n')) {
        if (!line.trim()) continue;

        // Fast-skip pseudo-tags and hash lines
        if (line.startsWith('{"_type": "ptag"')) continue;
        if (line.startsWith('{"_type": "sha256"')) continue;

        try {
            const entry = JSON.parse(line);
            if (entry._type !== 'tag') continue;
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

    return tags;
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
 * @returns Output with extracted chunks
 */
function computeChunksWithCtags(
    input: ComputeChunksInput,
    lines: string[],
    tags: TagEntry[],
): ComputeChunksOutput {
    const totalLines = lines.length;
    const topLevelRanges = findTopLevelRanges(tags);
    expandRangesToIncludePrecedingLines(topLevelRanges, lines);
    const chunks: Chunk[] = [];

    let cursor = 1; // 1-based current line

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
async function computeChunks(input: ComputeChunksInput): Promise<ComputeChunksOutput> {
    try {
        const contentBuffer = await fs.promises.readFile(input.filePath);
        const content = contentBuffer.toString('utf8');
        const lines = content.split('\n');

        const ext = path.extname(input.filePath).toLowerCase();

        if (CPP_EXTENSIONS.has(ext)) {
            // Try to read the ctags file; fall back to simple chunking if unavailable
            try {
                const tagsContent = await fs.promises.readFile(input.ctagsPath, 'utf8');
                const tags = parseContainerTags(tagsContent);

                if (tags.length > 0) {
                    return computeChunksWithCtags(input, lines, tags);
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

// ── Embedding search ────────────────────────────────────────────────────────

/**
 * Search a set of embedding vectors for the top-K most similar to a query
 * vector using cosine similarity.
 *
 * The `input.vectors` SharedArrayBuffer is received by reference (zero-copy)
 * because `SharedArrayBuffer` is explicitly designed for cross-thread sharing
 * without structured-clone copying.
 *
 * @param input - Search embeddings input with shared vector buffer, query, and slot list
 * @returns Output with the top-K most similar slot indices and their scores
 */
// TODO: add a new worker task which normalizes all vectors to unit length
// which can be run at indexing time to speed up cosine similarity search
// (only dot product needed at query time).
function searchEmbeddings(input: SearchEmbeddingsInput): SearchEmbeddingsOutput {
    try {
        const { vectors: sab, dims, queryVector, slots, topK } = input;

        if (queryVector.length !== dims) {
            return {
                type: 'searchEmbeddings',
                slots: [],
                scores: [],
                error: `Query vector length (${queryVector.length}) does not match dims (${dims})`,
            };
        }

        if (slots.length === 0) {
            return { type: 'searchEmbeddings', slots: [], scores: [] };
        }

        const allVectors = new Float32Array(sab);

        // Pre-compute query magnitude
        let queryMagSq = 0;
        for (let d = 0; d < dims; d++) {
            queryMagSq += queryVector[d] * queryVector[d];
        }
        const queryMag = Math.sqrt(queryMagSq);

        if (queryMag === 0) {
            return {
                type: 'searchEmbeddings',
                slots: [],
                scores: [],
                error: 'Query vector has zero magnitude',
            };
        }

        // Compute cosine similarity for every requested slot
        // but only keep the top K results to return.
        const k = Math.min(topK, slots.length);

        // Simple approach: collect all (slot, score) pairs, then partial-sort.
        // For typical topK << slots.length this is efficient enough and avoids
        // the complexity of a heap implementation.
        const scored: { slot: number; score: number }[] = new Array(slots.length);

        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            const offset = slot * dims;

            let dot = 0;
            let vecMagSq = 0;
            for (let d = 0; d < dims; d++) {
                const v = allVectors[offset + d];
                dot += queryVector[d] * v;
                vecMagSq += v * v;
            }

            const vecMag = Math.sqrt(vecMagSq);
            const score = vecMag > 0 ? dot / (queryMag * vecMag) : 0;
            scored[i] = { slot, score };
        }

        // Full sort descending, then take the first k elements.
        // A partial sort (e.g. min-heap) would be faster for small k
        // relative to n, but the simplicity here is fine for now.
        scored.sort((a, b) => b.score - a.score);

        const topSlots = new Array<number>(k);
        const topScores = new Array<number>(k);
        for (let i = 0; i < k; i++) {
            topSlots[i] = scored[i].slot;
            topScores[i] = scored[i].score;
        }

        return { type: 'searchEmbeddings', slots: topSlots, scores: topScores };
    } catch (error) {
        return {
            type: 'searchEmbeddings',
            slots: [],
            scores: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

// Listen for messages from the main thread
if (parentPort) {
    parentPort.on('message', async (input: SearchInput | IndexInput | ComputeChunksInput | SearchEmbeddingsInput) => {
        if (input.type === 'index') {
            const output = await indexFile(input);
            parentPort!.postMessage(output);
        } else if (input.type === 'computeChunks') {
            const output = await computeChunks(input);
            parentPort!.postMessage(output);
        } else if (input.type === 'searchEmbeddings') {
            const output = searchEmbeddings(input);
            parentPort!.postMessage(output);
        } else {
            const output = await searchFile(input);
            parentPort!.postMessage(output);
        }
    });
}
