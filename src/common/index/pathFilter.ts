// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as path from 'path';
import picomatch from 'picomatch';
import { log } from '../logger';

/**
 * PathFilter centralizes all file/directory inclusion and exclusion logic
 * for the content index. It is constructed once from user configuration
 * (includePaths, excludePatterns, fileExtensions) and provides a single
 * source of truth.
 *
 * Include paths are plain directory paths. Exclude patterns use picomatch
 * glob syntax (e.g., `d:/cs/src/chrome/{fuchsia,mac,linux}/**`).
 */
export class PathFilter {
    private includePaths: string[] = [];
    private normalizedIncludePaths: string[] = [];
    private readonly fileExtensions: string[];
    private readonly excludeMatcher: ((testPath: string) => boolean) | null;

    /**
     * Create a new PathFilter.
     *
     * @param includePaths - Directory paths to include
     * @param excludePatterns - Picomatch glob patterns to exclude
     *   (e.g., `d:/cs/src/chrome/{fuchsia,mac,linux}/**`)
     * @param fileExtensions - File extensions to include (e.g., '.cc', '.h')
     */
    constructor(
        includePaths: string[],
        excludePatterns: string[],
        fileExtensions: string[],
    ) {
        this.setIncludePaths(includePaths);
        this.fileExtensions = fileExtensions.map(ext => ext.toLowerCase());

        // Compile all exclude patterns into a single matcher for fast testing.
        // picomatch accepts an array and short-circuits on the first match.
        this.excludeMatcher = excludePatterns.length > 0
            ? picomatch(excludePatterns, { windows: true })
            : null;

        log(`PathFilter: includePaths =\n${JSON.stringify(this.includePaths, null, 2)}`);
        log(`PathFilter: excludePatterns =\n${JSON.stringify(excludePatterns, null, 2)}`);
        log(`PathFilter: fileExtensions =\n${JSON.stringify(this.fileExtensions, null, 2)}`);
    }

    /**
     * Check whether a file should be included in the content index.
     *
     * A file is included when:
     * 1. Its extension matches one of the configured file extensions.
     * 2. It is under at least one include path (or includePaths is empty).
     * 3. It does not match any exclude pattern.
     *
     * @param filePath - Absolute file path to test
     * @returns true if the file should be included
     */
    shouldIncludeFile(filePath: string): boolean {
        // Check extension
        const ext = path.extname(filePath).toLowerCase();
        if (!this.fileExtensions.includes(ext)) {
            return false;
        }

        // Check include paths (if specified)
        if (this.normalizedIncludePaths.length > 0) {
            const normalizedPath = path.normalize(filePath).toLowerCase();
            const isUnderIncludePath = this.normalizedIncludePaths.some(
                normalizedInclude => normalizedPath.startsWith(normalizedInclude)
            );
            if (!isUnderIncludePath) {
                return false;
            }
        }

        // Check exclude patterns
        if (this.excludeMatcher && this.excludeMatcher(filePath)) {
            return false;
        }

        return true;
    }

    /**
     * Get the configured include paths.
     * Used by CacheManager to know which directories to scan and by
     * FileWatcher to set up external directory watchers.
     */
    getIncludePaths(): string[] {
        return this.includePaths;
    }

    /**
     * Set the include paths.
     * Called when no include paths are configured and the workspace folders
     * are used as a fallback.
     */
    setIncludePaths(paths: string[]): void {
        this.includePaths = paths;
        this.normalizedIncludePaths = paths.map(p => path.normalize(p).toLowerCase());
    }

    /**
     * Get the configured file extensions.
     * Used by FileWatcher to build glob patterns for file system watchers.
     */
    getFileExtensions(): string[] {
        return this.fileExtensions;
    }
}
