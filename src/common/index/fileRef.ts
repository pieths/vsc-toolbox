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
    private workspacePath: string;

    constructor(filePath: string, cacheDir: string, workspaceRoot: string = '') {
        this.filePath = filePath;
        this.idxPath = this.computeIdxPath(cacheDir);
        this.workspacePath = this.computeWorkspacePath(workspaceRoot);
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
     * Compute the workspace-relative path for this file.
     *
     * If the file is under the workspace root, returns a forward-slash
     * normalized relative path (e.g. `src/media/foo.cpp`).  Otherwise
     * returns the empty string.
     *
     * Forward slashes are used regardless of OS so that chunk prefixes
     * (and therefore embedding vectors) are platform-independent.
     */
    private computeWorkspacePath(workspaceRoot: string): string {
        if (!workspaceRoot) { return ''; }
        const relative = path.relative(workspaceRoot, this.filePath);
        // path.relative returns a '..' prefix if the file is outside the root
        if (relative.startsWith('..')) { return ''; }
        return relative.replace(/\\/g, '/');
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

    /**
     * Get the workspace-relative path (forward-slash normalized).
     * Empty string if the file is not inside the workspace.
     */
    getWorkspacePath(): string {
        return this.workspacePath;
    }
}
