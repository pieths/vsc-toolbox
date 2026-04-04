// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Shared interfaces and types for the content index functionality
 */

import type { IndexSymbol } from './parsers/types';

/**
 * Represents a single line match within a file.
 */
export interface SearchResult {
    /** 0-based line number */
    line: number;
    /** Full line text (trimmed) */
    text: string;
}

/**
 * Document type tag for search results.
 * Used to distinguish knowledge base documents from other files.
 */
export const enum DocumentType {
    /** Regular source / text file */
    Standard = 0,
    /** Markdown knowledge base document (has an Overview heading in the first two symbols) */
    KnowledgeBase = 1,
}

/**
 * Search results for a single file.
 */
export interface FileSearchResults {
    /** Absolute file path */
    filePath: string;
    /** The type of document this file represents */
    docType: DocumentType;
    /** Line matches within the file */
    results: SearchResult[];
    /** For KnowledgeBase docs: 0-based inclusive line range of the Overview body (excludes heading) */
    overviewRange?: { startLine: number; endLine: number };
}

/**
 * Result of a search operation.
 * Contains either per-file results or an error message.
 */
export interface SearchResults {
    /** Per-file search results (empty if error or no matches) */
    fileMatches: FileSearchResults[];
    /** Total number of files that matched (before maxResults truncation) */
    totalFiles: number;
    /** Total number of line matches across all matched files (before maxResults truncation) */
    totalMatches: number;
    /** Error message if the search failed */
    error?: string;
}

/**
 * Per-pattern match data from a search.
 */
export interface PatternMatch {
    /** Index into the patterns array (0-based) */
    patternIndex: number;
    /** Number of matches for this pattern in the file */
    frequency: number;
    /** 0-based line numbers where this pattern matched (deduplicated, sorted) */
    lineNumbers: number[];
}

/**
 * Search output data returned from a worker thread.
 * Contains per-pattern frequency and line number data.
 */
export interface SearchOutput {
    /** Discriminator for message type */
    type: 'search';
    /** Absolute file path that was searched */
    filePath: string;
    /** Total number of lines in the file */
    totalLines: number;
    /** Per-pattern match data. Only patterns with >= 1 match are included. */
    patternMatches: PatternMatch[];
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
    /** Output path for the *.idx file */
    idxPath: string;
}

/**
 * Status of an indexing operation
 */
export const enum IndexStatus {
    /** File was indexed (*.idx file was created) */
    Indexed,
    /** File was skipped (*.idx file was already up-to-date) */
    Skipped,
    /** Source file no longer exists on disk */
    Deleted,
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
    /** Path to the generated *.idx file, or null on error */
    idxPath: string | null;
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
     * SHA-256 hex digest of the full chunk text, including the
     * context prefix. Computed in the worker thread after the
     * parser returns chunks with prefixes applied.
     *
     * Empty string until computed by the worker.
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
    /** Absolute path to the corresponding *.idx file */
    idxPath: string;
    /** SHA-256 of the source file version currently stored in the database, if any */
    storedSha256?: string;
    /**
     * Workspace-relative path (forward-slash normalized), used for
     * chunk context prefixes. Empty string if the file is outside
     * the workspace.
     */
    workspacePath: string;
}

/**
 * Status of a compute chunks operation
 */
export const enum ComputeChunksStatus {
    /** Chunks were successfully computed */
    Computed,
    /** Chunking was skipped */
    Skipped,
    /** Chunking failed due to an error */
    Error,
}

/**
 * Output data returned from a worker thread after computing chunks
 */
export interface ComputeChunksOutput {
    /** Discriminator for message type */
    type: 'computeChunks';
    /** Final status of the compute chunks operation */
    status: ComputeChunksStatus;
    /** Absolute file path that was processed */
    filePath: string;
    /** Array of text chunks extracted from the file */
    chunks: Chunk[];
    /** SHA-256 hex digest of the source file. Present only when chunking succeeded. */
    sha256?: string;
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

// ── Batch messages (ThreadPool ↔ Worker threads) ────────────────────

/** Batch search request sent from ThreadPool to a worker thread */
export interface SearchBatchRequest {
    type: 'searchBatch';
    messageId: number;
    /** Search query string (space-separated terms) */
    query: string;
    /** Absolute file paths to search */
    filePaths: string[];
    /** When true, treat query as a single regex pattern */
    isRegexp: boolean;
}

/** Batch search response sent from a worker thread to ThreadPool */
export interface SearchBatchResponse {
    type: 'searchBatch';
    messageId: number;
    outputs: SearchOutput[];
}

/** Batch index request sent from ThreadPool to a worker thread */
export interface IndexBatchRequest {
    type: 'indexBatch';
    messageId: number;
    inputs: IndexInput[];
}

/** Batch index response sent from a worker thread to ThreadPool */
export interface IndexBatchResponse {
    type: 'indexBatch';
    messageId: number;
    outputs: IndexOutput[];
}

/** Batch compute chunks request sent from ThreadPool to a worker thread */
export interface ComputeChunksBatchRequest {
    type: 'computeChunksBatch';
    messageId: number;
    inputs: ComputeChunksInput[];
}

/** Batch compute chunks response sent from a worker thread to ThreadPool */
export interface ComputeChunksBatchResponse {
    type: 'computeChunksBatch';
    messageId: number;
    outputs: ComputeChunksOutput[];
}

/** Any batch request from ThreadPool to a worker thread */
export type WorkerBatchRequest =
    | SearchBatchRequest
    | IndexBatchRequest
    | ComputeChunksBatchRequest;

/** Any batch response from a worker thread to ThreadPool */
export type WorkerBatchResponse =
    | SearchBatchResponse
    | IndexBatchResponse
    | ComputeChunksBatchResponse;

// ── IPC messages (VectorCacheClient ↔ VectorCacheHost) ───────────────

/** Request sent from VectorCacheClient to VectorCacheHost to initialize */
export interface VectorCacheInitRequest {
    type: 'init';
    dbPath: string;
    vectorDimension: number;
    /** TCP port for the HTTP cache server. If omitted, no HTTP server is started. */
    httpPort?: number;
    /** Bind address for the HTTP cache server. Default: '0.0.0.0'. */
    httpHost?: string;
    /** SQLite page cache size in MB. If omitted, uses the default (50MB). */
    cacheSizeMB?: number;
}

/** Response sent from VectorCacheHost to VectorCacheClient after init */
export interface VectorCacheInitAckResponse {
    type: 'init-ack';
    entryCount: number;
}

/** Request sent from VectorCacheClient to VectorCacheHost to shut down */
export interface VectorCacheShutdownRequest {
    type: 'shutdown';
}

/** Log message sent from VectorCacheHost to VectorCacheClient */
export interface VectorCacheLogMessage {
    type: 'log';
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
}

/** Get embeddings request sent from VectorCacheClient to VectorCacheHost */
export interface VectorCacheGetEmbeddingsRequest {
    type: 'getEmbeddings';
    messageId: number;
    sha256s: string[];
}

/** Get embeddings response sent from VectorCacheHost to VectorCacheClient */
export interface VectorCacheGetEmbeddingsResponse {
    type: 'getEmbeddings';
    messageId: number;
    /** Parallel array: base64-encoded f32 string for cache hits, null for misses */
    vectors: (string | null)[];
}

/** Add embeddings request sent from VectorCacheClient to VectorCacheHost */
export interface VectorCacheAddEmbeddingsRequest {
    type: 'addEmbeddings';
    messageId: number;
    sha256s: string[];
    /** Vectors as base64-encoded f32 strings */
    vectors: string[];
}

/** Add embeddings response (ack) sent from VectorCacheHost to VectorCacheClient */
export interface VectorCacheAddEmbeddingsResponse {
    type: 'addEmbeddings';
    messageId: number;
}

/** Any batch request from VectorCacheClient to VectorCacheHost */
export type VectorCacheBatchRequest =
    | VectorCacheGetEmbeddingsRequest
    | VectorCacheAddEmbeddingsRequest;

/** Any batch response from VectorCacheHost to VectorCacheClient */
export type VectorCacheBatchResponse =
    | VectorCacheGetEmbeddingsResponse
    | VectorCacheAddEmbeddingsResponse;

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
    /** Whether the content index is enabled */
    enable: boolean;
    /** Number of worker threads (0 = auto-detect using os.cpus().length) */
    workerThreads: number;
    /** List of directory paths to include in search (empty = all workspace files) */
    includePaths: string[];
    /** Picomatch glob patterns to exclude from the index */
    excludePatterns: string[];
    /** List of file extensions to include (e.g., '.cc', '.h') */
    fileExtensions: string[];
    /** Whether to enable embedding generation and vector search */
    enableEmbeddings: boolean;
    /** Directory containing the knowledge base documents */
    knowledgeBaseDirectory: string;
    /** Whether to enable the vector cache for caching embedding vectors */
    enableVectorCache: boolean;
    /** Whether to enable the HTTP server for remote vector cache queries */
    enableVectorCacheServer: boolean;
    /** Bind address for the vector cache HTTP server */
    vectorCacheServerHost: string;
    /** TCP port for the vector cache HTTP server */
    vectorCacheServerPort: number;
    /** Maximum memory (MB) for the vector cache SQLite page cache (0 = SQLite default) */
    vectorCacheMemoryMB: number;
    /** Base URL of a remote vector cache server for cached embedding lookups */
    remoteEmbeddingServerAddress: string;
}

// ── IPC messages (ContentIndex ↔ ContentIndexHost) ───────────────────

// -- Client → Host --

/** Initialize the content index with configuration and paths */
export interface ContentIndexInitRequest {
    type: 'init';
    config: ContentIndexConfig;
    workspaceRoot: string;
    extensionPath: string;
    globalStoragePath: string;
    nodePath: string;
}

/** Search for content matching a glob pattern query */
export interface ContentIndexSearchRequest {
    type: 'search';
    messageId: number;
    query: string;
    include?: string;
    exclude?: string;
    /** When true, treat query as a single regex pattern */
    isRegexp: boolean;
    /** Maximum number of files to return. 0 or -1 for no limit. */
    maxResults?: number;
}

/** Get symbols for one or more files */
export interface ContentIndexGetSymbolsRequest {
    type: 'getSymbols';
    messageId: number;
    filePaths: string[];
}

/** Search embeddings by query string */
export interface ContentIndexSearchEmbeddingsRequest {
    type: 'searchEmbeddings';
    messageId: number;
    query: string;
    topK: number;
}

/** Notify host of configuration change (triggers reset) */
export interface ContentIndexConfigChangeRequest {
    type: 'configChange';
    config: ContentIndexConfig;
}

/** Graceful shutdown */
export interface ContentIndexShutdownRequest {
    type: 'shutdown';
}

/** Any request from ContentIndex to ContentIndexHost */
export type ContentIndexRequest =
    | ContentIndexInitRequest
    | ContentIndexSearchRequest
    | ContentIndexGetSymbolsRequest
    | ContentIndexSearchEmbeddingsRequest
    | ContentIndexConfigChangeRequest
    | ContentIndexShutdownRequest;

// -- Host → Client --

/** Init acknowledgement — sent after initial indexing completes */
export interface ContentIndexInitAckResponse {
    type: 'init-ack';
    fileCount: number;
}

/** Search response */
export interface ContentIndexSearchResponse {
    type: 'search';
    messageId: number;
    fileMatches: FileSearchResults[];
    totalFiles: number;
    totalMatches: number;
    error?: string;
}

/**
 * Get symbols response — symbols keyed by file path.
 * Both this Map and IndexSymbol.attrs (AttrMap) are preserved
 * natively by V8's advanced serialization.
 */
export interface ContentIndexGetSymbolsResponse {
    type: 'getSymbols';
    messageId: number;
    symbols: Map<string, IndexSymbol[]>;
}

/** Search embeddings response */
export interface ContentIndexSearchEmbeddingsResponse {
    type: 'searchEmbeddings';
    messageId: number;
    results: NearestEmbeddingResult[];
}

/** Config change acknowledgement — sent after restart completes */
export interface ContentIndexConfigChangeResponse {
    type: 'configChange-ack';
    fileCount: number;
}

/** Log message forwarded from child to extension host output channel */
export interface ContentIndexLogMessage {
    type: 'log';
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
}

/**
 * Notification message — displayed to the user via vscode.window.
 * Used for errors (model download failure, server not found, etc.)
 * and informational messages (indexing complete, etc.).
 */
export interface ContentIndexNotification {
    type: 'notification';
    level: 'info' | 'error';
    message: string;
}

/** Status update for the status bar item */
export interface ContentIndexStatusUpdate {
    type: 'status';
    /** null = hide status bar item; string = show with this text */
    text: string | null;
}

/** Any response/message from ContentIndexHost to ContentIndex */
export type ContentIndexResponse =
    | ContentIndexInitAckResponse
    | ContentIndexSearchResponse
    | ContentIndexGetSymbolsResponse
    | ContentIndexSearchEmbeddingsResponse
    | ContentIndexConfigChangeResponse
    | ContentIndexLogMessage
    | ContentIndexNotification
    | ContentIndexStatusUpdate;
