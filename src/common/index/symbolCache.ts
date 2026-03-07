// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as fs from 'fs';
import { FileRef } from './fileRef';
import type { IndexFile, IndexSymbol } from './parsers/types';
import { getParserForFile } from './parsers/registry';

// ── LRU cache (private implementation detail) ───────────────────────────────

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

// ── SymbolCache ─────────────────────────────────────────────────────────────

/**
 * Provides cached access to hydrated symbols from `*.idx` files.
 *
 * Wraps a {@link SymbolsCache} LRU and exposes symbol-reading,
 * container lookup, and invalidation methods.  CacheManager creates
 * a single instance and delegates all symbol I/O through it.
 */
export class SymbolCache {
    private symbolsCache = new SymbolsCache();

    /**
     * Get hydrated symbols from a file's `*.idx` file.
     * Uses an LRU cache keyed by idx path + mtime.
     *
     * @param fileRef - The FileRef handle to get symbols for
     * @returns Array of IndexSymbol objects, or null if the idx file
     *          cannot be read.
     */
    async getSymbols(fileRef: FileRef): Promise<IndexSymbol[] | null> {
        const idxPath = fileRef.getIdxPath();
        const filePath = fileRef.getFilePath();

        // Get idx file mtime for cache staleness check
        let idxMtime: number;
        try {
            idxMtime = fs.statSync(idxPath).mtimeMs;
        } catch {
            return null;  // idx file doesn't exist
        }

        // Check LRU cache
        const cached = this.symbolsCache.get(idxPath, idxMtime);
        if (cached !== undefined) {
            return cached;
        }

        // Read and parse the idx file
        try {
            const content = await fs.promises.readFile(idxPath, 'utf8');
            const [_sha256, _version, _filePath, rawSymbols] = JSON.parse(content) as IndexFile;

            const fileParser = getParserForFile(filePath);
            const symbols = fileParser.readIndex(rawSymbols);

            // Cache with the original mtime to avoid marking the
            // cached entry as newer than it could be.
            this.symbolsCache.set(idxPath, symbols, idxMtime);
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
    findInnermostSymbol(candidates: IndexSymbol[]): IndexSymbol | null {
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
     * Evict the cached symbols for a file.
     * Called by CacheManager when processing a delete.
     *
     * @param fileRef - The FileRef handle to invalidate
     */
    invalidateSymbols(fileRef: FileRef): void {
        this.symbolsCache.delete(fileRef.getIdxPath());
    }
}
