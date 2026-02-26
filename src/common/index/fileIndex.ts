// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import { AttrKey, CONTAINER_TYPES } from './parsers/types';
import type { IndexFile, IndexSymbol } from './parsers/types';
import { getParserForFile } from './parsers/registry';

// ── Symbols cache ───────────────────────────────────────────────────────────

/**
 * Cached symbols entry with mtime for staleness detection.
 */
interface CachedSymbols {
    symbols: IndexSymbol[];
    mtime: number;  // mtime of idx file when parsed
}

/**
 * Simple LRU cache for hydrated IndexSymbol arrays.
 * Keys are idx file paths, values are IndexSymbol arrays with their mtime.
 */
class SymbolsCache {
    private cache = new Map<string, CachedSymbols>();
    private maxSize: number;

    constructor(maxSize: number = 100) {
        this.maxSize = maxSize;
    }

    /**
     * Get cached symbols if the mtime matches.
     * Returns undefined if not cached or mtime doesn't match.
     */
    get(key: string, currentMtime: number): IndexSymbol[] | undefined {
        const entry = this.cache.get(key);
        if (entry !== undefined) {
            if (entry.mtime === currentMtime) {
                // Move to end (most recently used)
                this.cache.delete(key);
                this.cache.set(key, entry);
                return entry.symbols;
            } else {
                // Stale entry - remove it
                this.cache.delete(key);
            }
        }
        return undefined;
    }

    set(key: string, symbols: IndexSymbol[], mtime: number): void {
        this.cache.delete(key);

        if (this.cache.size >= this.maxSize) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey !== undefined) {
                this.cache.delete(oldestKey);
            }
        }

        this.cache.set(key, { symbols, mtime });
    }

    delete(key: string): void {
        this.cache.delete(key);
    }

    clear(): void {
        this.cache.clear();
    }
}

// Module-level LRU cache shared by all FileIndex instances
const symbolsCache = new SymbolsCache(300);

// ── Idx header reading ──────────────────────────────────────────────────────

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

// ── FileIndex ───────────────────────────────────────────────────────────────

/**
 * FileIndex manages metadata for a single file in the index.
 * It stores the file path and the path to its `*.idx` file.
 *
 * Validity is determined by comparing the source file's SHA-256
 * against the hash stored in the `*.idx` file header, and checking
 * the format version against the current parser's version.
 */
export class FileIndex {
    private filePath: string;
    private idxPath: string;

    constructor(filePath: string, cacheDir: string) {
        this.filePath = filePath;
        this.idxPath = this.computeIdxPath(cacheDir);
    }

    /**
     * Compute the deterministic idx file path for this source file.
     * Uses SHA-256 hash of the full path to avoid conflicts.
     */
    private computeIdxPath(cacheDir: string): string {
        const hash = crypto.createHash('sha256')
            .update(this.filePath)
            .digest('hex')
            .substring(0, 16)
            .toUpperCase();
        const fileName = path.basename(this.filePath);
        const firstChar = fileName[0]?.toLowerCase() ?? '_';
        const subDir = firstChar >= 'a' && firstChar <= 'z' ? firstChar : '_';
        return path.join(cacheDir, subDir, `${fileName}.${hash}.idx`);
    }

    /**
     * Get the file path.
     */
    getFilePath(): string {
        return this.filePath;
    }

    /**
     * Get the path to the idx file.
     * Always returns the computed path - use isValid() to check if it exists.
     */
    getIdxPath(): string {
        return this.idxPath;
    }

    /**
     * Check if the `*.idx` file is up-to-date for the current source file.
     *
     * Fast path: if the idx file's mtime >= source mtime, assume valid.
     * Slow path: read source, compute SHA-256, compare against the hash
     * stored in the idx file header. Also verifies that the format version
     * matches the current parser's version.
     */
    isValid(): boolean {
        try {
            const sourceMtime = fs.statSync(this.filePath).mtimeMs;
            const idxMtime = fs.statSync(this.idxPath).mtimeMs;
            if (idxMtime >= sourceMtime) {
                return true;
            }

            // Slow path: compare SHA-256 and format version
            const sourceContent = fs.readFileSync(this.filePath);
            const sha256 = crypto.createHash('sha256').update(sourceContent).digest('hex');
            const fileParser = getParserForFile(this.filePath);
            const header = readIdxHeader(this.idxPath);

            return header !== null &&
                header.sha256 === sha256 &&
                header.version === fileParser.formatVersion;
        } catch {
            return false;
        }
    }

    /**
     * Clear cached symbols for this file.
     */
    invalidate(): void {
        symbolsCache.delete(this.idxPath);
    }

    /**
     * Load and hydrate symbols from the `*.idx` file.
     * Uses an LRU cache keyed by idx path + mtime.
     *
     * @returns Array of IndexSymbol objects, or null if the idx file
     *          is not valid or cannot be read.
     */
    private async getSymbols(): Promise<IndexSymbol[] | null> {
        if (!this.isValid()) {
            return null;
        }

        // Get idx file mtime for cache staleness check
        const idxMtime = fs.statSync(this.idxPath).mtimeMs;

        // Check LRU cache
        const cached = symbolsCache.get(this.idxPath, idxMtime);
        if (cached !== undefined) {
            return cached;
        }

        // Read and parse the idx file
        try {
            const content = await fs.promises.readFile(this.idxPath, 'utf8');
            const [_sha256, _version, _filePath, rawSymbols] = JSON.parse(content) as IndexFile;

            const fileParser = getParserForFile(this.filePath);
            const symbols = fileParser.readIndex(rawSymbols);

            // Cache with the original mtime to avoid marking the
            // cached entry as newer than it could be.
            symbolsCache.set(this.idxPath, symbols, idxMtime);
            return symbols;
        } catch {
            return null;
        }
    }

    /**
     * From a list of candidate symbols, return the one with the
     * tightest enclosing range (smallest line span, then latest
     * start line as tiebreaker). Returns null if the list is empty.
     */
    private findInnermostSymbol(candidates: IndexSymbol[]): IndexSymbol | null {
        if (candidates.length === 0) {
            return null;
        }
        let best = candidates[0];
        for (let i = 1; i < candidates.length; i++) {
            const s = candidates[i];
            const bestSpan = best.endLine - best.startLine;
            const candidateSpan = s.endLine - s.startLine;
            if (candidateSpan < bestSpan ||
                (candidateSpan === bestSpan && s.startLine > best.startLine)) {
                best = s;
            }
        }
        return best;
    }

    /**
     * Get the fully qualified name for a symbol at a given line.
     *
     * @param name - The symbol name to look up
     * @param line - 0-based line number
     * @returns The fully qualified name (e.g., "namespace::Class::method")
     *          or the original name if not found
     */
    async getFullyQualifiedName(name: string, line: number): Promise<string> {
        const symbols = await this.getSymbols();
        if (symbols === null) {
            return name;
        }

        // Find all symbols matching the name whose range contains the line
        const matches = symbols.filter(s =>
            s.name === name && s.startLine <= line && line <= s.endLine
        );

        const best = this.findInnermostSymbol(matches);
        if (!best) {
            return name;
        }

        return best.attrs.get(AttrKey.FullyQualifiedName) ?? best.name;
    }

    /**
     * Get all hydrated symbols for this file.
     *
     * @param sort - If true, sort symbols by start line (ascending)
     * @returns Array of IndexSymbol objects, or null if the idx file
     *          is not valid or cannot be read.
     */
    async getAllSymbols(sort: boolean = false): Promise<IndexSymbol[] | null> {
        const symbols = await this.getSymbols();
        if (symbols === null) {
            return null;
        }
        if (sort) {
            return [...symbols].sort((a, b) => a.startLine - b.startLine);
        }
        return symbols;
    }

    /**
     * Get the innermost container (function, class, namespace, etc.)
     * that contains a given line.
     *
     * @param line - 0-based line number
     * @returns The innermost containing IndexSymbol, or null if none found
     */
    async getContainer(line: number): Promise<IndexSymbol | null> {
        const symbols = await this.getSymbols();
        if (symbols === null) {
            return null;
        }

        // Find all container symbols whose range contains the given line.
        // IndexSymbol positions are 0-based. The end position (endLine,
        // endColumn) is exclusive, but endLine itself can still contain
        // symbol content (up to endColumn), so use <= for line-level checks.
        const containers = symbols.filter(s =>
            CONTAINER_TYPES.has(s.type) &&
            s.startLine <= line &&
            line <= s.endLine
        );

        return this.findInnermostSymbol(containers);
    }
}
