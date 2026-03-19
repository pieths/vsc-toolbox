// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { fork, ChildProcess } from 'child_process';
import {
    ContentIndexConfig,
    ContentIndexSearchRequest,
    ContentIndexGetSymbolsRequest,
    ContentIndexSearchEmbeddingsRequest,
    ContentIndexSearchResponse,
    ContentIndexGetSymbolsResponse,
    ContentIndexSearchEmbeddingsResponse,
    NearestEmbeddingResult,
    SearchResults,
    ContentIndexResponse,
} from './types';
import { FileSymbols } from './fileSymbols';
import type { IndexSymbol } from './parsers/types';
import { debug, log, warn, error } from '../logger';

/** Query request types that use messageId-based correlation. */
type ContentIndexQueryRequest =
    | ContentIndexSearchRequest
    | ContentIndexGetSymbolsRequest
    | ContentIndexSearchEmbeddingsRequest;

/** Maximum time (ms) to wait for the child process to exit during shutdown */
const SHUTDOWN_TIMEOUT_MS = 10000;

/**
 * Get the content index configuration from VS Code settings.
 */
function getConfig(): ContentIndexConfig {
    const config = vscode.workspace.getConfiguration('vscToolbox.contentIndex');

    const enable = config.get<boolean>('enable', false);

    let workerThreads = config.get<number>('workerThreads', 0);
    if (workerThreads === 0) {
        workerThreads = os.cpus().length; // Auto-detect
    }

    const includePaths = config.get<string[]>('includePaths', []);
    const excludePatterns = config.get<string[]>('excludePatterns', []);
    const fileExtensions = config.get<string[]>('fileExtensions', ['.cc', '.h']);
    const enableEmbeddings = config.get<boolean>('enableEmbeddings', false);
    const knowledgeBaseDirectory = config.get<string>('knowledgeBaseDirectory', '').trim();

    return {
        enable,
        workerThreads,
        includePaths,
        excludePatterns,
        fileExtensions,
        enableEmbeddings,
        knowledgeBaseDirectory
    };
}

/**
 * ContentIndex is the public interface for accessing the content index
 * functionality. Internally it is an IPC proxy — all heavy work
 * (indexing, searching, embedding) runs in a child process
 * ({@link ContentIndexHost}) on a standalone Node.js binary.
 *
 * Usage:
 *   const index = ContentIndex.getInstance();
 *   const results = await index.getDocumentMatches('myFunction*');
 */
export class ContentIndex {
    private static instance: ContentIndex | null = null;
    private static enableWarningShown: boolean = false;

    private context: vscode.ExtensionContext | null = null;
    private childProcess: ChildProcess | null = null;
    private statusBarItem: vscode.StatusBarItem | null = null;
    private enabled: boolean = false;
    private ready: boolean = false;
    private fileCount: number = 0;
    private disposed: boolean = false;
    private restartAttempted: boolean = false;
    private configChangeNotificationShown: boolean = false;

    // IPC request/response correlation
    private nextMessageId: number = 0;
    private pendingRequests: Map<number, {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
    }> = new Map();

    /**
     * Private constructor - use getInstance() instead.
     */
    private constructor() { }

    /**
     * Get the singleton instance of ContentIndex.
     * Creates the instance if it doesn't exist.
     */
    static getInstance(): ContentIndex {
        if (!ContentIndex.instance) {
            ContentIndex.instance = new ContentIndex();
        } else if (!ContentIndex.instance.enabled && !ContentIndex.enableWarningShown) {
            // Show a one-time warning when callers try to use the content
            // index while it is disabled. This is in the `else` block so
            // that the warning is not shown on the very first call (from
            // extension.activate) which creates the instance before
            // initialize() has had a chance to set the enabled flag.
            ContentIndex.enableWarningShown = true;
            vscode.window.showWarningMessage(
                'VSC Toolbox: Content index is disabled. Enable "vscToolbox.contentIndex.enable" in settings to use indexing and search tools.');
        }

        return ContentIndex.instance;
    }

    /**
     * Initialize the content index system.
     * Forks a child process, sends configuration, and waits for
     * initial indexing to complete.
     *
     * @param context - VS Code extension context for registering disposables
     */
    async initialize(context: vscode.ExtensionContext): Promise<void> {
        // Use this.context as a guard to prevent duplicate initialization.
        // Subscriptions (cleanup, config listener) must only be registered once.
        if (this.context) {
            log('ContentIndex: Already initialized, skipping');
            return;
        }

        if (this.disposed) {
            error('ContentIndex: Cannot initialize a disposed instance');
            return;
        }

        // Register for cleanup (once)
        context.subscriptions.push({
            dispose: () => this.dispose()
        });

        // Listen for configuration changes (once)
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('vscToolbox.contentIndex')) {
                    this.handleConfigChange();
                }
            })
        );

        this.context = context;

        // Check if content index is enabled
        const config = getConfig();
        if (!config.enable) {
            log('ContentIndex: Disabled in settings, skipping initialization');
            return;
        }

        // Wait briefly before indexing to allow VS Code and other extensions
        // to finish any post-startup file modifications that would trigger
        // unnecessary re-indexing (e.g., formatOnSave, insertFinalNewline).
        await new Promise(resolve => setTimeout(resolve, 10000));

        this.enabled = true;
        await this.startComponents();
    }

    // ── Child process lifecycle ───────────────────────────────────────

    /**
     * Fork the child process and send the init message.
     * Resolves when initial indexing is complete (init-ack received).
     */
    private async startComponents(): Promise<void> {
        if (!this.context) {
            error('ContentIndex: No context available, cannot start components');
            return;
        }

        try {
            const config = getConfig();
            const nodePath = path.join(this.context.extensionPath, 'bin', 'win_x64', 'node', 'node.exe');
            const hostPath = path.join(__dirname, 'contentIndexHost.js');
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

            // Fork the child process.
            //
            // V8 serialization compatibility note:
            // serialization: 'advanced' uses V8's structured clone algorithm
            // (binary format) instead of JSON. This natively preserves Map
            // instances (needed for IndexSymbol.attrs). The extension host
            // runs Node 22 (Electron) while the child runs Node 24 — both
            // use V8 serialization format v15+. The types used in IPC
            // messages (objects, arrays, strings, numbers, Maps with
            // numeric keys and primitive values) have been stable since
            // format v13 (Node 13.2, circa 2019).
            //
            // fork() defaults to process.execPath which, inside VS Code's
            // extension host, points to Electron (Code.exe). Electron caps
            // memory at relatively conservative values. Using a standalone
            // Node.js binary removes that limit, allowing the child process
            // to allocate more memory if needed.
            //
            // stdio: 'ignore' for stdout/stderr because all logging goes
            // through IPC messages. Using 'inherit' would share the
            // extension host's file descriptors with the child (and its
            // grandchildren — WorkerHost, VectorCacheHost), which prevents
            // the 'exit' event from firing until all inherited handles are
            // closed, blocking the extension host's event loop.
            this.childProcess = fork(hostPath, [], {
                execPath: nodePath,
                stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
                serialization: 'advanced',
                windowsHide: true,
            } as any);

            this.childProcess.on('message', (msg: ContentIndexResponse) => {
                this.handleChildMessage(msg);
            });

            this.childProcess.on('error', (err: Error) => {
                error(`ContentIndex: Child process error: ${err.message}`);
            });

            this.childProcess.on('exit', (code: number | null, signal: string | null) => {
                // If this.childProcess is null, stopComponents() is handling
                // the shutdown intentionally — not an unexpected exit.
                if (!this.disposed && this.childProcess) {
                    warn(`ContentIndex: Child process exited unexpectedly (code=${code}, signal=${signal}). Restarting...`);
                    this.ready = false;

                    // Reject all in-flight requests
                    for (const [, pending] of this.pendingRequests) {
                        pending.reject(new Error(`Child process exited (code=${code})`));
                    }
                    this.pendingRequests.clear();

                    // Restart the child process (once)
                    this.childProcess = null;
                    if (!this.restartAttempted) {
                        this.restartAttempted = true;
                        warn('ContentIndex: Attempting restart...');
                        this.startComponents().catch(err => {
                            error(`ContentIndex: Restart after crash failed - ${err}`);
                        });
                    } else {
                        error('ContentIndex: Already attempted restart, not retrying');
                        vscode.window.showErrorMessage(
                            'VSC Toolbox: Content index process crashed repeatedly. Restart VS Code to try again.');
                    }
                }
            });

            // Send init and wait for init-ack
            const fileCount = await this.sendInit(config, workspaceRoot, nodePath);
            this.fileCount = fileCount;
            this.ready = true;
            this.restartAttempted = false;

            vscode.window.showInformationMessage(`VSC Toolbox: Content index: Indexed ${fileCount} files`);
            log('ContentIndex: Indexing complete');
        } catch (err) {
            error(`ContentIndex: Indexing failed - ${err}`);
            vscode.window.showErrorMessage(`VSC Toolbox: Content index failed: ${err}`);
        }
    }

    /**
     * Send the init message and wait for init-ack.
     * The promise resolves when the child sends init-ack, or rejects
     * if the child process exits before acknowledging.
     *
     * No timeout is used — indexing large codebases can legitimately
     * take a long time. The child's exit event is the error signal.
     */
    private sendInit(config: ContentIndexConfig, workspaceRoot: string, nodePath: string): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            if (!this.childProcess?.connected) {
                reject(new Error('Child process not connected'));
                return;
            }

            const onMessage = (msg: ContentIndexResponse) => {
                if (msg.type === 'init-ack') {
                    this.childProcess?.removeListener('message', onMessage);
                    this.childProcess?.removeListener('exit', onExit);
                    resolve(msg.fileCount);
                }
            };

            const onExit = (code: number | null) => {
                this.childProcess?.removeListener('message', onMessage);
                reject(new Error(`Child process exited during init (code=${code})`));
            };

            this.childProcess.on('message', onMessage);
            this.childProcess.once('exit', onExit);

            this.childProcess.send({
                type: 'init',
                config,
                workspaceRoot,
                extensionPath: this.context!.extensionPath,
                globalStoragePath: this.context!.globalStorageUri.fsPath,
                nodePath,
            });
        });
    }

    /**
     * Send shutdown message, wait for child process to exit,
     * and clean up all client-side state.
     */
    private async stopComponents(): Promise<void> {
        this.ready = false;

        // Reject all in-flight requests
        for (const [, pending] of this.pendingRequests) {
            pending.reject(new Error('ContentIndex stopped'));
        }
        this.pendingRequests.clear();

        this.statusBarItem?.dispose();
        this.statusBarItem = null;

        if (!this.childProcess) {
            return;
        }

        const proc = this.childProcess;
        this.childProcess = null;

        // If already exited, nothing to wait for
        if (proc.exitCode !== null || proc.signalCode !== null) {
            log(`ContentIndex: stopComponents — child already exited (code=${proc.exitCode}, signal=${proc.signalCode})`);
            return;
        }

        // Wait for the child process to exit. Register the exit listener
        // BEFORE sending shutdown/disconnect to avoid a race where the
        // exit event fires synchronously during disconnect() and is missed.
        log(`ContentIndex: stopComponents — waiting for child process to exit (pid=${proc.pid})`);
        const exitPromise = new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                warn('ContentIndex: stopComponents — child did not exit within timeout, force-killing...');
                try { proc.disconnect(); } catch { /* already disconnected */ }
                try { proc.kill(); } catch { /* already dead */ }
                resolve();
            }, SHUTDOWN_TIMEOUT_MS);

            proc.on('exit', (code, signal) => {
                log(`ContentIndex: stopComponents — child exited (code=${code}, signal=${signal})`);
                clearTimeout(timeout);
                // IPC channel is automatically closed when the child exits.
                resolve();
            });
        });

        // Now send shutdown. Don't disconnect IPC yet — the child needs
        // the IPC channel open to receive the shutdown message and do its
        // cleanup (stop llama-server, close databases, etc.). The child
        // calls process.exit(0) when done, which fires the exit event.
        // IPC is only disconnected in the timeout path as a last resort.
        if (proc.connected) {
            log('ContentIndex: stopComponents — sending shutdown message');
            try {
                proc.send({ type: 'shutdown' });
            } catch {
                // Ignore send errors during shutdown
            }
        } else {
            log('ContentIndex: stopComponents — child not connected, killing directly');
            try { proc.kill(); } catch { /* already dead */ }
        }

        await exitPromise;

        log('ContentIndex: stopComponents — child process stopped');
    }

    // ── IPC message handling ──────────────────────────────────────────

    /**
     * Handle an incoming message from the child process.
     */
    private handleChildMessage(msg: ContentIndexResponse): void {
        switch (msg.type) {
            case 'init-ack':
                // Handled by sendInit's one-time listener
                break;

            case 'search':
            case 'getSymbols':
            case 'searchEmbeddings': {
                const pending = this.pendingRequests.get(msg.messageId);
                if (pending) {
                    this.pendingRequests.delete(msg.messageId);
                    pending.resolve(msg);
                }
                break;
            }

            case 'configChange-ack':
                this.fileCount = msg.fileCount;
                this.ready = true;
                log(`ContentIndex: Config change complete — ${msg.fileCount} files`);
                break;

            case 'log': {
                const text = `[ContentIndexHost] ${msg.message}`;
                switch (msg.level) {
                    case 'debug': debug(text); break;
                    case 'info': log(text); break;
                    case 'warn': warn(text); break;
                    case 'error': error(text); break;
                }
                break;
            }

            case 'notification':
                if (msg.level === 'error') {
                    vscode.window.showErrorMessage(`VSC Toolbox: ${msg.message}`);
                } else {
                    vscode.window.showInformationMessage(`VSC Toolbox: ${msg.message}`);
                }
                break;

            case 'status':
                if (msg.text === null) {
                    this.statusBarItem?.dispose();
                    this.statusBarItem = null;
                } else {
                    if (!this.statusBarItem) {
                        this.statusBarItem = vscode.window.createStatusBarItem(
                            vscode.StatusBarAlignment.Right, 100
                        );
                    }
                    this.statusBarItem.text = msg.text;
                    this.statusBarItem.tooltip = 'VSC Toolbox: Content index';
                    this.statusBarItem.show();
                }
                break;
        }
    }

    /**
     * Send a request to the child process and return a promise
     * for the correlated response.
     */
    private sendRequest<T>(request: ContentIndexQueryRequest): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            if (!this.childProcess?.connected) {
                reject(new Error('Child process not connected'));
                return;
            }

            this.pendingRequests.set(request.messageId, { resolve, reject });
            this.childProcess.send(request);
        });
    }

    // ── Config change handling ────────────────────────────────────────

    /**
     * Handle configuration changes.
     * Shows a notification asking the user whether to restart the index.
     * Only one notification is shown at a time; subsequent changes while
     * a notification is visible are silently absorbed.
     */
    private handleConfigChange(): void {
        const enabledInConfig = getConfig().enable;

        if (!this.enabled && !enabledInConfig) {
            // Was disabled, still disabled — nothing to do
            return;
        }

        if (!this.enabled && enabledInConfig) {
            // Turning on: start components directly (no delay needed)
            log('ContentIndex: Enabling via config change');
            this.enabled = true;
            this.startComponents().catch(err => {
                error(`ContentIndex: Enable after config change failed - ${err}`);
            });
            return;
        }

        if (this.enabled && !enabledInConfig) {
            // Turning off: stop components directly
            log('ContentIndex: Disabling via config change');
            this.enabled = false;
            ContentIndex.enableWarningShown = false;
            this.stopComponents().catch(err => {
                error(`ContentIndex: Disable after config change failed - ${err}`);
            });
            return;
        }

        // Still enabled — other settings changed, prompt for restart
        if (this.configChangeNotificationShown) {
            return;
        }

        this.configChangeNotificationShown = true;

        vscode.window.showInformationMessage(
            'VSC Toolbox: Content index settings have changed. Restart the index?',
            'Yes', 'No'
        ).then(selection => {
            this.configChangeNotificationShown = false;
            if (selection === 'Yes') {
                this.sendConfigChange().catch(err => {
                    error(`ContentIndex: Config change failed - ${err}`);
                });
            }
        });
    }

    /**
     * Send a configChange message to the child process.
     * The child stops and restarts internally, then sends configChange-ack.
     */
    private async sendConfigChange(): Promise<void> {
        if (!this.childProcess?.connected) {
            warn('ContentIndex: Cannot send config change — child process not connected');
            return;
        }

        this.ready = false;
        const config = getConfig();
        this.childProcess.send({ type: 'configChange', config });
        // The child will send configChange-ack when done,
        // handled in handleChildMessage which sets ready=true.
    }

    // ── Public API ────────────────────────────────────────────────────

    /**
     * Check if the index is ready to be used.
     */
    isReady(): boolean {
        return this.ready;
    }

    /**
     * Get the number of files currently indexed.
     */
    getFileCount(): number {
        return this.fileCount;
    }

    /**
     * Search for content matching a glob pattern query.
     *
     * @param query - User search query with glob patterns (* and ?) and space-separated AND terms
     * @param include - Optional comma-separated glob patterns to include only matching file paths
     * @param exclude - Optional comma-separated glob patterns to exclude matching file paths
     * @param token - Optional cancellation token
     * @returns SearchResults with per-file results array and optional error
     */
    async getDocumentMatches(
        query: string,
        include?: string,
        exclude?: string,
        token?: vscode.CancellationToken
    ): Promise<SearchResults> {
        if (!query.trim()) {
            return { fileMatches: [], error: 'Search query cannot be empty' };
        }

        if (!this.ready) {
            warn('ContentIndex: Not ready');
            return { fileMatches: [] };
        }

        if (this.disposed) {
            warn('ContentIndex: Instance has been disposed');
            return { fileMatches: [] };
        }

        try {
            const messageId = this.nextMessageId++;
            const response = await this.sendRequest<ContentIndexSearchResponse>({
                type: 'search',
                messageId,
                query,
                include,
                exclude,
            });
            return {
                fileMatches: response.fileMatches,
                error: response.error,
            };
        } catch (err) {
            error(`ContentIndex: Search failed - ${err}`);
            return { fileMatches: [] };
        }
    }

    /**
     * Get hydrated symbols for one or more files.
     *
     * @param filePaths - Array of absolute file paths to load symbols for
     * @returns Map of file path to FileSymbols
     */
    async getSymbols(filePaths: string[]): Promise<Map<string, FileSymbols>> {
        if (!this.ready) {
            warn('ContentIndex: Not ready');
            return new Map();
        }

        try {
            const messageId = this.nextMessageId++;
            const response = await this.sendRequest<ContentIndexGetSymbolsResponse>({
                type: 'getSymbols',
                messageId,
                filePaths,
            });

            // Reconstruct FileSymbols from raw IndexSymbol[] received over IPC
            const result = new Map<string, FileSymbols>();
            for (const [filePath, symbols] of response.symbols) {
                result.set(filePath, new FileSymbols(filePath, symbols));
            }
            return result;
        } catch (err) {
            error(`ContentIndex: getSymbols failed - ${err}`);
            return new Map();
        }
    }

    /**
     * Search the embedding index for text chunks most similar to a query string.
     *
     * @param query - Natural language or code query to search for
     * @param topK - Maximum number of results to return (default 50)
     * @returns Array of nearest embedding results ordered from most to least similar
     */
    async searchEmbeddings(query: string, topK: number = 50): Promise<NearestEmbeddingResult[]> {
        if (!this.ready) {
            warn('ContentIndex: Not ready');
            return [];
        }

        try {
            const messageId = this.nextMessageId++;
            const response = await this.sendRequest<ContentIndexSearchEmbeddingsResponse>({
                type: 'searchEmbeddings',
                messageId,
                query,
                topK,
            });
            return response.results;
        } catch (err) {
            error(`ContentIndex: searchEmbeddings failed - ${err}`);
            return [];
        }
    }

    /**
     * Clean up all resources.
     */
    async dispose(): Promise<void> {
        if (this.disposed) {
            return;
        }

        this.disposed = true;
        await this.stopComponents();
        this.context = null;

        log('ContentIndex: Disposed');
    }
}
