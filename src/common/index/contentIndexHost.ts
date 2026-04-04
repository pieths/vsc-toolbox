// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Content Index Host — child process entry point.
 *
 * This process is forked by ContentIndex and owns all the heavy machinery:
 * CacheManager, ThreadPool, FileWatcher, LlamaServer, PathFilter, etc.
 *
 * It receives requests over IPC, delegates to the appropriate component,
 * and sends responses back. Log messages, user-facing notifications, and
 * status bar updates are forwarded to the parent via typed IPC messages.
 *
 * Communication:
 *   ContentIndex (extension host) ──IPC──► ContentIndexHost (this process)
 *   ContentIndex (extension host) ◄──IPC── ContentIndexHost (this process)
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { CacheManager } from './cacheManager';
import { ThreadPool } from './workers/threadPool';
import { FileWatcher } from './fileWatcher';
import { LlamaServer } from './embeddings/llamaServer';
import { PathFilter } from './pathFilter';
import { FileSymbols } from './fileSymbols';
import { rankFiles } from './bm25';
import { configureLogger } from '../logger';
import type {
    ContentIndexConfig,
    ContentIndexRequest,
    ContentIndexInitRequest,
    ContentIndexSearchRequest,
    ContentIndexGetSymbolsRequest,
    ContentIndexSearchEmbeddingsRequest,
    ContentIndexConfigChangeRequest,
    FileSearchResults,
    NearestEmbeddingResult,
} from './types';
import { DocumentType } from './types';

// ── State ─────────────────────────────────────────────────────────────

let cacheManager: CacheManager | null = null;
let threadPool: ThreadPool | null = null;
let fileWatcher: FileWatcher | null = null;
let llamaServer: LlamaServer | null = null;
let pathFilter: PathFilter | null = null;

/** Environment paths that stay constant for the lifetime of the process. */
interface HostPaths {
    workspaceRoot: string;
    extensionPath: string;
    globalStoragePath: string;
    nodePath: string;
}

let hostPaths: HostPaths | null = null;

// ── Logging (forwarded to parent via IPC) ─────────────────────────────

function sendLog(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    process.send?.({ type: 'log', level, message });
}

function sendNotification(level: 'info' | 'error', message: string): void {
    process.send?.({ type: 'notification', level, message });
}

function sendStatus(text: string | null): void {
    process.send?.({ type: 'status', text });
}

// ── Install log hooks ─────────────────────────────────────────────────

// Wire the content index logger to forward all messages to the parent
// process via IPC. This must happen before any component is created.
configureLogger({
    debug: (msg: string) => sendLog('debug', msg),
    log: (msg: string) => sendLog('info', msg),
    warn: (msg: string) => sendLog('warn', msg),
    error: (msg: string) => sendLog('error', msg),
});

// ── Component lifecycle ───────────────────────────────────────────────

/**
 * Create all components and run initial indexing.
 * Returns the number of files indexed (0 on failure).
 */
async function startComponents(config: ContentIndexConfig): Promise<number> {
    if (!hostPaths) {
        sendLog('error', 'ContentIndexHost: startComponents called before init');
        return 0;
    }

    try {
        sendStatus('$(sync~spin) VSC Toolbox: Indexing...');

        const {
            workerThreads: configWorkerThreads,
            includePaths,
            excludePatterns,
            fileExtensions,
            enableEmbeddings,
            knowledgeBaseDirectory,
            enableVectorCache,
            enableVectorCacheServer,
            vectorCacheServerHost,
            vectorCacheServerPort,
            vectorCacheMemoryMB,
            remoteEmbeddingServerAddress,
        } = config;

        const workerThreads = configWorkerThreads === 0
            ? os.cpus().length
            : configWorkerThreads;

        const workspaceFolders = hostPaths.workspaceRoot ? [hostPaths.workspaceRoot] : [];

        // Create components
        cacheManager = new CacheManager();
        threadPool = new ThreadPool(workerThreads);
        pathFilter = new PathFilter(
            includePaths, excludePatterns, fileExtensions,
            knowledgeBaseDirectory, workspaceFolders,
        );
        fileWatcher = new FileWatcher(cacheManager, pathFilter);
        await fileWatcher.initialize();

        // Initialize llama server for embeddings (if enabled)
        llamaServer = new LlamaServer();
        if (enableEmbeddings) {
            const llamaCppDir = path.join(hostPaths.extensionPath, 'bin', 'win_x64', 'llama.cpp');
            const modelDir = path.join(hostPaths.globalStoragePath, 'models');
            llamaServer.initialize(
                llamaCppDir,
                modelDir,
                (level, message) => sendNotification(level, message),
            );
            await llamaServer.start();
        }

        // Run initial indexing
        await cacheManager.initialize(
            pathFilter,
            threadPool,
            llamaServer,
            enableEmbeddings,
            hostPaths.nodePath,
            hostPaths.workspaceRoot,
            enableVectorCache,
            enableVectorCacheServer ? vectorCacheServerPort : undefined,
            enableVectorCacheServer ? vectorCacheServerHost : undefined,
            vectorCacheMemoryMB,
            remoteEmbeddingServerAddress,
        );

        const fileCount = cacheManager.getFileCount();

        sendStatus(null);
        sendLog('info', `ContentIndexHost: Indexing complete — ${fileCount} files`);
        return fileCount;
    } catch (err) {
        sendStatus(null);
        sendLog('error', `ContentIndexHost: startComponents failed — ${err}`);
        sendNotification('error', `Content index failed: ${err}`);
        return 0;
    }
}

async function stopComponents(): Promise<void> {
    await fileWatcher?.dispose();
    fileWatcher = null;

    await threadPool?.dispose();
    threadPool = null;

    await llamaServer?.stop();
    llamaServer = null;

    pathFilter = null;

    await cacheManager?.dispose();
    cacheManager = null;

    sendLog('info', 'ContentIndexHost: Components stopped');
}

async function handleInit(msg: ContentIndexInitRequest): Promise<void> {
    const { config, workspaceRoot, extensionPath, globalStoragePath, nodePath } = msg;

    hostPaths = { workspaceRoot, extensionPath, globalStoragePath, nodePath };

    const fileCount = await startComponents(config);
    process.send?.({ type: 'init-ack', fileCount });
}

async function handleSearch(msg: ContentIndexSearchRequest): Promise<void> {
    const { messageId, query, include, exclude, isRegexp, maxResults } = msg;

    try {
        if (!cacheManager || !threadPool || !cacheManager.isReady()) {
            process.send?.({ type: 'search', messageId, fileMatches: [], totalFiles: 0, totalMatches: 0, error: 'Index not ready' });
            return;
        }

        if (!query.trim()) {
            process.send?.({ type: 'search', messageId, fileMatches: [], totalFiles: 0, totalMatches: 0, error: 'Search query cannot be empty' });
            return;
        }

        const allFiles = cacheManager.getAllPaths(include, exclude);
        if (allFiles.length === 0) {
            const dirs = pathFilter?.getIncludePaths() ?? [];
            const exts = pathFilter?.getFileExtensions() ?? [];

            const dirList = dirs.length > 0 ? dirs.map(d => `  - ${d}`).join('\n') : '  (none)';
            const extList = exts.length > 0 ? exts.map(e => `  - ${e}`).join('\n') : '  (none)';

            const lines: string[] = [
                'No indexed files matched the requested path filters.\n',
                'The content index includes files in these directories:\n', dirList,
                '\nand only includes files with these extensions:\n', extList,
            ];

            if (include) {
                lines.push(`\nThe include pattern "${include}" did not match any of the indexed files.`);
            }
            if (exclude) {
                lines.push(`\nThe exclude pattern "${exclude}" may have filtered out all remaining files.`);
            }

            lines.push(
                '\nTry broadening the include/exclude filters or'
                + ' check that the target directory is part of'
                + ' the content index configuration.',
            );

            const error = lines.join('\n');
            process.send?.({ type: 'search', messageId, fileMatches: [], totalFiles: 0, totalMatches: 0, error });
            return;
        }

        const outputs = await threadPool.searchAll(query, allFiles, isRegexp);

        // Phase 1: BM25 scoring
        // Filter out error outputs before scoring.
        const validOutputs = outputs.filter(o => !o.error && o.patternMatches.length > 0);
        const scored = rankFiles(validOutputs, allFiles.length);

        // Apply maxResults limit (0 or -1 means no limit).
        const limit = maxResults && maxResults > 0 ? maxResults : scored.length;
        const topFiles = scored.slice(0, limit);

        // Phase 2: Hydrate line text for top-N files.
        // Read each file and extract the text for matched lines.
        const fileResults: FileSearchResults[] = [];
        const mdFileResults: FileSearchResults[] = [];

        for (const sf of topFiles) {
            let lines: string[];
            try {
                const content = await fs.promises.readFile(sf.filePath, 'utf8');
                lines = content.split('\n');
            } catch {
                continue; // File no longer readable, skip
            }

            const results = sf.lineNumbers.map(ln => ({
                line: ln,
                text: (lines[ln] ?? '').trimEnd(),
            }));

            const fsr: FileSearchResults = {
                filePath: sf.filePath,
                docType: DocumentType.Standard,
                results,
            };
            fileResults.push(fsr);
            if (sf.filePath.endsWith('.md')) {
                mdFileResults.push(fsr);
            }
        }

        // Detect knowledge base documents among markdown files
        if (mdFileResults.length > 0) {
            const mdFilePaths = mdFileResults.map(fsr => fsr.filePath);
            const rawSymbolsMap = await cacheManager.getAllSymbols(mdFilePaths);

            for (const fsr of mdFileResults) {
                const symbols = rawSymbolsMap.get(fsr.filePath);
                if (symbols) {
                    const fileSymbols = new FileSymbols(fsr.filePath, symbols);
                    if (fileSymbols.docType === DocumentType.KnowledgeBase) {
                        fsr.docType = DocumentType.KnowledgeBase;
                        fsr.overviewRange = fileSymbols.overviewRange;
                    }
                }
            }
        }

        // Compute totals from scored (pre-truncation) results.
        const totalFiles = scored.length;
        const totalMatches = scored.reduce((sum, sf) => sum + sf.lineNumbers.length, 0);

        process.send?.({ type: 'search', messageId, fileMatches: fileResults, totalFiles, totalMatches });
    } catch (err) {
        sendLog('error', `ContentIndexHost: Search failed — ${err}`);
        process.send?.({ type: 'search', messageId, fileMatches: [], totalFiles: 0, totalMatches: 0, error: String(err) });
    }
}

async function handleGetSymbols(msg: ContentIndexGetSymbolsRequest): Promise<void> {
    const { messageId, filePaths } = msg;

    try {
        if (!cacheManager || !cacheManager.isReady()) {
            process.send?.({ type: 'getSymbols', messageId, symbols: new Map() });
            return;
        }

        const symbols = await cacheManager.getAllSymbols(filePaths);
        process.send?.({ type: 'getSymbols', messageId, symbols });
    } catch (err) {
        sendLog('error', `ContentIndexHost: GetSymbols failed — ${err}`);
        process.send?.({ type: 'getSymbols', messageId, symbols: new Map() });
    }
}

async function handleSearchEmbeddings(msg: ContentIndexSearchEmbeddingsRequest): Promise<void> {
    const { messageId, query, topK } = msg;

    try {
        if (!cacheManager || !cacheManager.isReady() || !llamaServer?.isReady()) {
            process.send?.({ type: 'searchEmbeddings', messageId, results: [] });
            return;
        }

        const prefixedQuery = llamaServer.getQueryPrefix() + query;
        const queryVectorB64 = await llamaServer.embed(prefixedQuery);
        if (!queryVectorB64) {
            sendLog('warn', 'ContentIndexHost: Failed to embed query');
            process.send?.({ type: 'searchEmbeddings', messageId, results: [] });
            return;
        }

        // Convert base64 → Float32Array for vector search.
        // Copy into a new ArrayBuffer via Uint8Array to guarantee
        // 4-byte alignment. Node's Buffer.from(string, 'base64')
        // may return a view into a shared internal pool whose
        // byteOffset is not aligned to 4 bytes, which would cause
        // Float32Array to throw a RangeError.
        const buf = Buffer.from(queryVectorB64, 'base64');
        const queryVector = new Float32Array(new Uint8Array(buf).buffer);

        const results = await cacheManager.getNearestEmbeddings(queryVector, topK);
        process.send?.({ type: 'searchEmbeddings', messageId, results });
    } catch (err) {
        sendLog('error', `ContentIndexHost: SearchEmbeddings failed — ${err}`);
        process.send?.({ type: 'searchEmbeddings', messageId, results: [] });
    }
}

async function handleConfigChange(msg: ContentIndexConfigChangeRequest): Promise<void> {
    sendLog('info', 'ContentIndexHost: Config change — restarting...');

    try {
        await stopComponents();
        const fileCount = await startComponents(msg.config);
        process.send?.({ type: 'configChange-ack', fileCount });
    } catch (err) {
        sendLog('error', `ContentIndexHost: Config change restart failed — ${err}`);
        process.send?.({ type: 'configChange-ack', fileCount: 0 });
    }
}

// ── IPC from ContentIndex ─────────────────────────────────────────────

process.on('message', async (msg: ContentIndexRequest) => {
    switch (msg.type) {
        case 'init':
            await handleInit(msg);
            break;
        case 'search':
            await handleSearch(msg);
            break;
        case 'getSymbols':
            await handleGetSymbols(msg);
            break;
        case 'searchEmbeddings':
            await handleSearchEmbeddings(msg);
            break;
        case 'configChange':
            await handleConfigChange(msg);
            break;
        case 'shutdown':
            await stopComponents();
            process.exit(0);
            break;
    }
});

// ── Global error handlers ─────────────────────────────────────────────

process.on('uncaughtException', (err) => {
    sendLog('error', `[ContentIndexHost] Uncaught exception: ${err.message}`);
    console.error('[ContentIndexHost] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
    sendLog('error', `[ContentIndexHost] Unhandled rejection: ${reason}`);
    console.error('[ContentIndexHost] Unhandled rejection:', reason);
});
