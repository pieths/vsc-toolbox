// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as crypto from 'crypto';
import * as path from 'path';

// ── FileRef ─────────────────────────────────────────────────────────────────

/**
 * Opaque handle for a single indexed file.
 * Stores the source file path and the computed `*.idx` file path.
 *
 * A `FileRef` may outlive the file it refers to — the underlying file
 * can be deleted between the time the handle is acquired and the time
 * it is used.  Query methods that accept a `FileRef` return `null`
 * (or some other default value) when the file no longer exists,
 * so callers must always check the return value.
 *
 * All symbol-reading operations go through {@link CacheManager}'s
 * drain-loop-gated query methods, which delegate to
 * {@link SymbolCache} for actual I/O.
 */
export class FileRef {
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
     */
    getIdxPath(): string {
        return this.idxPath;
    }
}
