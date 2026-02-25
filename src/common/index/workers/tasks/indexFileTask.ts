// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Worker task: index a file using tree-sitter and the parser registry.
 *
 * Parses the source file with web-tree-sitter (when a WASM grammar is
 * available) and writes a compact `*.idx` file containing the
 * {@link IndexFile} tuple.
 *
 * Tree-sitter `Parser` and `Language` instances are created at file
 * scope so they persist for the lifetime of the worker thread, avoiding
 * repeated WASM initialisation.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { IndexStatus } from '../../types';
import type { IndexInput, IndexOutput } from '../../types';
import type { IndexFile } from '../../parsers/types';
import { getParserForFile } from '../../parsers/registry';
import * as TreeSitter from 'web-tree-sitter';
type TSParser = TreeSitter.Parser;
type TSLanguage = TreeSitter.Language;

// ── Tree-sitter setup (persists for the worker thread's lifetime) ───────────

/** Directory containing the `*.wasm` grammar files. */
const WASM_DIR = path.join(__dirname, '..', 'bin', 'tree-sitter', 'languages');

/** Cached Language instances keyed by WASM filename (e.g. `"cpp.wasm"`). */
const languageCache = new Map<string, TSLanguage>();

/** Singleton Parser instance (reused across all indexFile calls). */
let tsParser: TSParser | null = null;

/** One-shot init promise so we only call `TreeSitter.init()` once. */
let initPromise: Promise<void> | null = null;

/**
 * Ensure tree-sitter is initialised and return the singleton parser.
 */
async function getTreeSitterParser(): Promise<TSParser> {
    if (!initPromise) {
        initPromise = TreeSitter.Parser.init();
    }
    await initPromise;

    if (!tsParser) {
        tsParser = new TreeSitter.Parser();
    }
    return tsParser;
}

/**
 * Load (or return cached) Language for a WASM grammar file.
 */
async function getLanguage(wasmFile: string): Promise<TSLanguage> {
    let lang = languageCache.get(wasmFile);
    if (!lang) {
        const wasmPath = path.join(WASM_DIR, wasmFile);
        lang = await TreeSitter.Language.load(wasmPath);
        languageCache.set(wasmFile, lang);
    }
    return lang;
}

// ── Staleness check helpers ─────────────────────────────────────────────────

/**
 * Byte offsets into the `*.idx` JSON tuple for the fast-path staleness check.
 *
 * Layout: `["<64 hex chars>",<version>,…`
 *   - Bytes [0..2)   → `["`
 *   - Bytes [2..66)  → 64-char SHA-256 hex digest
 *   - Bytes [66..68) → `",`
 *   - Bytes [68..)   → version digits followed by `,`
 */
const SHA256_OFFSET = 2;
const SHA256_HEX_LEN = 64;
const SHA256_END = SHA256_OFFSET + SHA256_HEX_LEN; // 66

/**
 * Read the sha256 and format version from the first bytes of an existing
 * `*.idx` file without parsing the full JSON.
 *
 * @returns `{ sha256, version }` or `null` if the file cannot be read.
 */
function readIdxHeader(idxPath: string): { sha256: string; version: number } | null {
    try {
        const fd = fs.openSync(idxPath, 'r');
        const buf = Buffer.alloc(80);
        const bytesRead = fs.readSync(fd, buf, 0, 80, 0);
        fs.closeSync(fd);
        if (bytesRead < SHA256_END + 2) return null;

        const raw = buf.toString('utf8', 0, bytesRead);
        const sha256 = raw.substring(SHA256_OFFSET, SHA256_END);

        // After the sha256 closing quote: `",<version>,…`
        const afterQuote = SHA256_END; // points at `"`
        if (raw[afterQuote] !== '"' || raw[afterQuote + 1] !== ',') return null;
        const versionStart = afterQuote + 2;
        const versionEnd = raw.indexOf(',', versionStart);
        if (versionEnd === -1) return null;
        const version = parseInt(raw.substring(versionStart, versionEnd), 10);
        if (isNaN(version)) return null;

        return { sha256, version };
    } catch {
        return null;
    }
}

// ── Main task ───────────────────────────────────────────────────────────────

/**
 * Index a file using tree-sitter and the parser registry.
 *
 * 1. Read source file, compute SHA-256.
 * 2. Fast-path: check existing `*.idx` for matching hash + format version.
 * 3. Parse with tree-sitter (if grammar available) → `parser.parseCst()`.
 * 4. Wrap in {@link IndexFile} tuple, write `*.idx`.
 *
 * @param input - Index input containing file path and idx output path
 * @returns Index output with idx path or error
 */
export async function indexFile(input: IndexInput): Promise<IndexOutput> {
    try {
        // Read source and compute hash
        const sourceContent = fs.readFileSync(input.filePath);
        const sha256 = crypto.createHash('sha256').update(sourceContent).digest('hex');

        // Look up the parser for this file
        const fileParser = getParserForFile(input.filePath);

        // Fast-path: skip if the *.idx file is already up-to-date
        const header = readIdxHeader(input.idxPath);
        if (header && header.sha256 === sha256 && header.version === fileParser.formatVersion) {
            return {
                type: 'index',
                status: IndexStatus.Skipped,
                filePath: input.filePath,
                idxPath: input.idxPath,
            };
        }

        // Parse source with tree-sitter (if grammar available)
        let symbols: unknown[][];
        if (fileParser.wasmGrammars.length > 0) {
            const parser = await getTreeSitterParser();
            const lang = await getLanguage(fileParser.wasmGrammars[0]);
            parser.setLanguage(lang);

            const tree = parser.parse(sourceContent.toString('utf8'));
            if (!tree) {
                throw new Error(`tree-sitter parse returned null for ${input.filePath}`);
            }
            try {
                symbols = fileParser.parseCst(tree.rootNode, input.filePath);
            } finally {
                // Free WASM memory for the tree to prevent unbounded heap growth
                tree.delete();
            }
        } else {
            // Default parser — no grammar needed
            symbols = fileParser.parseCst(null, input.filePath);
        }

        // Build IndexFile tuple and write
        const idxFile: IndexFile = [sha256, fileParser.formatVersion, input.filePath, symbols];
        const json = JSON.stringify(idxFile);

        // Ensure parent directory exists
        const dir = path.dirname(input.idxPath);
        fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(input.idxPath, json, 'utf8');

        return {
            type: 'index',
            status: IndexStatus.Indexed,
            filePath: input.filePath,
            idxPath: input.idxPath,
        };
    } catch (error) {
        return {
            type: 'index',
            status: IndexStatus.Failed,
            filePath: input.filePath,
            idxPath: null,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
