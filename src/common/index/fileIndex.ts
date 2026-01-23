// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * FileIndex manages the line-index cache for a single file.
 * It does NOT cache file content—only the byte positions of line starts.
 * This enables O(log n) line number lookup while minimizing memory usage.
 *
 * Note: All indexing is done through the thread pool (workerThread.ts).
 * This class is a pure data holder.
 */
export class FileIndex {
    private filePath: string;
    private lineStarts: number[] | null = null;

    constructor(filePath: string) {
        this.filePath = filePath;
    }

    /**
     * Set pre-built line starts (from worker thread).
     * @param lineStarts - Array of byte positions where each line starts
     */
    setLineStarts(lineStarts: number[]): void {
        this.lineStarts = lineStarts;
    }

    /**
     * Clear the cached line index (called when file is modified).
     */
    invalidate(): void {
        this.lineStarts = null;
    }

    /**
     * Check if the line index is built.
     */
    isIndexed(): boolean {
        return this.lineStarts !== null;
    }

    /**
     * Get the line starts array for worker threads to use.
     * Returns null if not indexed.
     */
    getLineStarts(): number[] | null {
        return this.lineStarts;
    }

    /**
     * Get the file path.
     */
    getFilePath(): string {
        return this.filePath;
    }
}
