// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Shared interfaces and types for the content index functionality
 */

/**
 * Details about a function extracted from ctags.
 */
export interface FunctionDetails {
    /** Fully qualified function name (e.g., "namespace::Class::method") */
    fullyQualifiedName: string;
    /** Scope/containing context (e.g., "namespace::Class") or undefined if global */
    scope: string | undefined;
    /** Function signature including return type and name (e.g., "int add(int a, int b)") */
    signature: string;
    /** 1-based start line of the function */
    startLine: number;
    /** 1-based end line of the function, or undefined if not available */
    endLine: number | undefined;
}

/**
 * Details about a container (function, class, namespace, etc.) extracted from ctags.
 */
export interface ContainerDetails {
    /** Name of the container */
    name: string;
    /** VS Code SymbolKind equivalent, or undefined if no mapping exists */
    type: number | undefined;  // vscode.SymbolKind value
    /** ctags kind (e.g., "function", "class", "namespace") */
    ctagsType: string;
    /** 1-based start line of the container */
    startLine: number;
    /** 1-based end line of the container */
    endLine: number;
}

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
 * Result of a search operation.
 * Contains either results array or an error message.
 */
export interface SearchResults {
    /** Array of search results (empty if error or no matches) */
    results: SearchResult[];
    /** Error message if the search failed */
    error?: string;
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
    /** Path to the ctags executable */
    ctagsPath: string;
    /** Output path for the tags file */
    tagsPath: string;
}

/**
 * Output data returned from a worker thread after indexing
 */
export interface IndexOutput {
    /** Discriminator for message type */
    type: 'index';
    /** Absolute file path that was indexed */
    filePath: string;
    /** Path to the generated tags file, or null on error */
    tagsPath: string | null;
    /** Error message if indexing failed */
    error?: string;
}

/**
 * Configuration for the content index functionality
 */
export interface ContentIndexConfig {
    /** Number of worker threads (0 = auto-detect using os.cpus().length) */
    workerThreads: number;
    /** List of directory paths to include in search (empty = all workspace files) */
    includePaths: string[];
    /** List of file extensions to include (e.g., '.cc', '.h') */
    fileExtensions: string[];
    /** Path to the ctags executable */
    ctagsPath: string;
}

/**
 * Input parameters for the language model tool
 */
export interface ContentSearchParams {
    /** Search query with space-separated OR terms and glob wildcards */
    query: string;
}
