// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as path from 'path';
import * as vscode from 'vscode';
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
     * If `includePaths` is empty the workspace folders are used as a
     * fallback so that all workspace files are indexed by default.
     *
     * When a `knowledgeBaseDirectory` is provided it is unconditionally
     * appended to the resolved include paths (if not already present),
     * ensuring knowledge-base documents are always indexed regardless of
     * whether the user explicitly configured include paths.
     *
     * @param includePaths - Directory paths to include (empty = workspace folders)
     * @param excludePatterns - Picomatch glob patterns to exclude
     *   (e.g., `d:/cs/src/chrome/{fuchsia,mac,linux}/**`)
     * @param fileExtensions - File extensions to include (e.g., '.cc', '.h')
     * @param knowledgeBaseDirectory - Optional knowledge base directory to always include
     */
    constructor(
        includePaths: string[],
        excludePatterns: string[],
        fileExtensions: string[],
        knowledgeBaseDirectory?: string,
    ) {
        // Resolve include paths: fall back to workspace folders when empty
        let resolvedPaths = includePaths;
        if (resolvedPaths.length === 0) {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders) {
                resolvedPaths = workspaceFolders.map(f => f.uri.fsPath);
            }
            log('PathFilter: No includePaths configured, using workspace folders');
        }

        // Append knowledge base directory if configured and not already present
        if (knowledgeBaseDirectory && !resolvedPaths.includes(knowledgeBaseDirectory)) {
            resolvedPaths = [...resolvedPaths, knowledgeBaseDirectory];
            log(`PathFilter: Appended knowledgeBaseDirectory: ${knowledgeBaseDirectory}`);
        }

        // Remove paths that are subdirectories of another included path
        resolvedPaths = this.removeRedundantPaths(resolvedPaths);

        this.includePaths = resolvedPaths;
        this.normalizedIncludePaths = resolvedPaths.map(p => path.normalize(p).toLowerCase());
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
     * Get the configured file extensions.
     * Used by FileWatcher to build glob patterns for file system watchers.
     */
    getFileExtensions(): string[] {
        return this.fileExtensions;
    }

    /**
     * Remove include paths that are subdirectories of another included path.
     *
     * Sorts the paths lexicographically so that parent directories appear
     * before their children, then does a single pass keeping only paths
     * that are not nested under the previously kept path.
     *
     * TODO: The case-insensitive comparison assumes a case-insensitive
     * file system (e.g. NTFS on Windows). On case-sensitive file systems
     * (e.g. ext4 on Linux) this would incorrectly collapse paths that
     * differ only in casing. This same assumption exists throughout the
     * class (e.g. shouldIncludeFile).
     */
    private removeRedundantPaths(paths: string[]): string[] {
        if (paths.length <= 1) {
            return paths;
        }

        const sorted = [...paths]
            .map(p => path.normalize(p))
            .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

        const result: string[] = [];
        for (const p of sorted) {
            const last = result[result.length - 1];
            if (!last || !p.toLowerCase().startsWith(last.toLowerCase() + path.sep)) {
                result.push(p);
            }
        }
        return result;
    }
}
