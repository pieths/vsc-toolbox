// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Shared interfaces and types for the file search tool
 */

/**
 * Represents a single search result
 */
export interface SearchResult {
    /** 1-based line number */
    line: number;
    /** Full line text (trimmed) */
    text: string;
    /** Absolute file path */
    filePath: string;
}

/**
 * Input data sent to a worker thread for searching
 */
export interface SearchInput {
    /** Discriminator for message type */
    type: 'search';
    /** Absolute file path to search */
    filePath: string;
    /** Regex pattern string to search for */
    regexPattern: string;
}

/**
 * Output data returned from a worker thread
 */
export interface SearchOutput {
    /** Absolute file path that was searched */
    filePath: string;
    /** Array of search results (without filePath, added by main thread) */
    results: { line: number; text: string }[];
    /** Error message if search failed */
    error?: string;
}

/**
 * Input data sent to a worker thread for indexing
 */
export interface IndexInput {
    /** Discriminator for message type */
    type: 'index';
    /** Absolute file path to index */
    filePath: string;
}

/**
 * Output data returned from a worker thread after indexing
 */
export interface IndexOutput {
    /** Discriminator for message type */
    type: 'index';
    /** Absolute file path that was indexed */
    filePath: string;
    /** Array of byte positions where each line starts, or null on error */
    lineStarts: number[] | null;
    /** Error message if indexing failed */
    error?: string;
}

/**
 * Configuration for the file search tool
 */
export interface FileSearchConfig {
    /** Number of worker threads (0 = auto-detect using os.cpus().length) */
    workerThreads: number;
    /** List of directory paths to include in search (empty = all workspace files) */
    includePaths: string[];
    /** List of file extensions to include (e.g., '.cc', '.h') */
    fileExtensions: string[];
}

/**
 * Input parameters for the language model tool
 */
export interface FileSearchParams {
    /** Search query with space-separated OR terms and glob wildcards */
    query: string;
}
