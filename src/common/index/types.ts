// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Shared interfaces and types for the content index functionality
 */

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
    /** Glob query string (space-separated AND terms with * and ? wildcards) */
    query: string;
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
    /** Discriminator for message type */
    type: 'search';
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
    /** Array of text chunks extracted from the file */
    chunks: Chunk[];
    /** Error message if chunking failed */
    error?: string;
}

/**
 * Log message sent from a worker thread to the main thread.
 */
export interface WorkerLogMessage {
    type: 'log';
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
}

/** Request sent from ThreadPool to WorkerHost to initialize worker threads */
export interface WorkerInitRequest {
    type: 'init';
    numThreads: number;
}

/** Response sent from WorkerHost to ThreadPool after init */
export interface WorkerInitResponse {
    type: 'init-ack';
    numThreads: number;
}

/** Request sent from ThreadPool to WorkerHost to shut down */
export interface WorkerShutdownRequest {
    type: 'shutdown';
}

// ── Batch IPC messages (ThreadPool ↔ WorkerHost) ─────────────────────

/** Batch search request sent from ThreadPool to WorkerHost over IPC */
export interface SearchBatchRequest {
    type: 'searchBatch';
    messageId: number;
    inputs: SearchInput[];
}

/** Batch search response sent from WorkerHost to ThreadPool over IPC */
export interface SearchBatchResponse {
    type: 'searchBatch';
    messageId: number;
    outputs: SearchOutput[];
}

/** Batch index request sent from ThreadPool to WorkerHost over IPC */
export interface IndexBatchRequest {
    type: 'indexBatch';
    messageId: number;
    inputs: IndexInput[];
}

/** Batch index response sent from WorkerHost to ThreadPool over IPC */
export interface IndexBatchResponse {
    type: 'indexBatch';
    messageId: number;
    outputs: IndexOutput[];
}

/** Batch compute chunks request sent from ThreadPool to WorkerHost over IPC */
export interface ComputeChunksBatchRequest {
    type: 'computeChunksBatch';
    messageId: number;
    inputs: ComputeChunksInput[];
}

/** Batch compute chunks response sent from WorkerHost to ThreadPool over IPC */
export interface ComputeChunksBatchResponse {
    type: 'computeChunksBatch';
    messageId: number;
    outputs: ComputeChunksOutput[];
}

/** Any batch request from ThreadPool to WorkerHost */
export type WorkerBatchRequest =
    | SearchBatchRequest
    | IndexBatchRequest
    | ComputeChunksBatchRequest;

/** Any batch response from WorkerHost to ThreadPool */
export type WorkerBatchResponse =
    | SearchBatchResponse
    | IndexBatchResponse
    | ComputeChunksBatchResponse;

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
    /** Picomatch glob patterns to exclude from the index */
    excludePatterns: string[];
    /** List of file extensions to include (e.g., '.cc', '.h') */
    fileExtensions: string[];
    /** Path to the ctags executable */
    ctagsPath: string;
    /** Whether to enable embedding generation and vector search */
    enableEmbeddings: boolean;
}
