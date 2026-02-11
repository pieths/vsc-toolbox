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
    /** 1-based column number of the function definition, or undefined if not available */
    startColumn: number | undefined;
    /** 1-based end line of the function, or undefined if not available */
    endLine: number | undefined;
}

/**
 * Details about a container (function, class, namespace, etc.) extracted from ctags.
 */
export interface ContainerDetails {
    /** Name of the container */
    name: string;
    /** Fully qualified name (e.g., "namespace::Class::method") */
    fullyQualifiedName: string;
    /** VS Code SymbolKind equivalent, or undefined if no mapping exists */
    type: number | undefined;  // vscode.SymbolKind value
    /** ctags kind (e.g., "function", "class", "namespace") */
    ctagsType: string;
    /** 1-based start line of the container */
    startLine: number;
    /** 1-based column number of the container definition, or undefined if not available */
    startColumn: number | undefined;
    /** 1-based end line of the container */
    endLine: number;
}

/**
 * Reference to a specific line in a file.
 */
export interface FileLineRef {
    /** Absolute file path */
    filePath: string;
    /** 1-based line number */
    line: number;
}

/**
 * Represents a single search result
 * TODO: should this use FileLineRef?
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
    /** Regex pattern strings to search for */
    regexPatterns: string[];
}

/**
 * A single search result with line number and text content
 */
export interface LineResult {
    line: number;
    text: string;
}

/**
 * Output data returned from a worker thread
 */
export interface SearchOutput {
    /** Absolute file path that was searched */
    filePath: string;
    /** Array of search results */
    results: LineResult[];
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
 * Status of an indexing operation
 */
export const enum IndexStatus {
    /** File was indexed (ctags was run and tags file was created) */
    Indexed,
    /** File was skipped (tags file was already up-to-date) */
    Skipped,
    /** Indexing failed (error occurred) */
    Failed,
}

/**
 * Output data returned from a worker thread after indexing
 */
export interface IndexOutput {
    /** Discriminator for message type */
    type: 'index';
    /** Final status of the indexing operation */
    status: IndexStatus;
    /** Absolute file path that was indexed */
    filePath: string;
    /** Path to the generated tags file, or null on error */
    tagsPath: string | null;
    /** Error message if indexing failed */
    error?: string;
}

/**
 * A single chunk of text from a file, defined by line range.
 */
export interface Chunk {
    /** 1-based start line of the chunk */
    startLine: number;
    /** 1-based end line of the chunk (inclusive) */
    endLine: number;
    /** Full text content from startLine to endLine (inclusive) */
    text: string;
    /**
     * SHA-256 hex digest of the chunk text.
     * Does not include the additional prefix.
     * This is solely the hash of the text content
     * between the startLine and endLine (inclusive)
     * as extracted from the file.
     */
    sha256: string;
}

/**
 * Input data sent to a worker thread for computing chunks
 */
export interface ComputeChunksInput {
    /** Discriminator for message type */
    type: 'computeChunks';
    /** Absolute file path to the source file */
    filePath: string;
    /** Absolute path to the corresponding ctags tags file */
    ctagsPath: string;
}

/**
 * Output data returned from a worker thread after computing chunks
 */
export interface ComputeChunksOutput {
    /** Discriminator for message type */
    type: 'computeChunks';
    /** Absolute file path that was processed */
    filePath: string;
    /** SHA-256 hex digest of the file contents that were chunked */
    sha256: string;
    /** Array of text chunks extracted from the file */
    chunks: Chunk[];
    /** Error message if chunking failed */
    error?: string;
}

/**
 * Input data sent to a worker thread for searching embeddings
 * via cosine similarity against a shared vector buffer.
 *
 * The `vectors` field is a SharedArrayBuffer and is transferred by
 * reference (zero-copy) to the worker thread.
 */
export interface SearchEmbeddingsInput {
    /** Discriminator for message type */
    type: 'searchEmbeddings';
    /** SharedArrayBuffer holding all embedding vectors contiguously (Float32 layout) */
    vectors: SharedArrayBuffer;
    /** Embedding dimensionality (number of floats per vector) */
    dims: number;
    /** The query embedding vector (one Float32Array of length `dims`) */
    queryVector: Float32Array;
    /** Slot indices into `vectors` that should be compared against the query */
    slots: number[];
    /** Maximum number of top results to return */
    topK: number;
}

/**
 * Output data returned from a worker thread after an embedding search
 */
export interface SearchEmbeddingsOutput {
    /** Discriminator for message type */
    type: 'searchEmbeddings';
    /**
     * Slot indices of the top-K most similar vectors, sorted from
     * most similar (highest cosine similarity) to least similar.
     * May contain fewer than `topK` entries if fewer slots were provided.
     */
    slots: number[];
    /**
     * Cosine similarity scores corresponding to each returned slot
     * (same order as `slots`).
     */
    scores: number[];
    /** Error message if the search failed */
    error?: string;
}

/**
 * A single result from a nearest-embedding search.
 */
export interface NearestEmbeddingResult {
    /** Absolute file path of the matching chunk */
    filePath: string;
    /** 1-based start line of the matching chunk */
    startLine: number;
    /** 1-based end line of the matching chunk (inclusive) */
    endLine: number;
    /** Cosine similarity score (higher is more similar) */
    score: number;
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
