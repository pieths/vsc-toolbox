// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import { ChildProcess, spawn } from 'child_process';
import { log, warn, error as logError } from '../logger';

/**
 * Model configuration for the embedding model.
 */
interface ModelConfig {
    /** Display name for UI messages */
    name: string;
    /** Download URL for the GGUF model file */
    url: string;
    /** Expected SHA256 hash of the downloaded file (lowercase hex) */
    sha256: string;
    /** Filename to save as */
    filename: string;
    /** Number of embedding dimensions */
    dimensions: number;
    /** Number of parallel slots (-np). Also used as the concurrency limit for embedBatch(). */
    parallelSlots: { cpu: number };
    /** CPU-specific llama-server CLI args (context, batch size, rope, pooling, etc.) */
    cpuArgs: string[];
    /** Prefix to prepend to user queries before embedding (empty string if none needed) */
    queryPrefix: string;
    /** Prefix to prepend to documents/passages during indexing (empty string if none needed) */
    indexPrefix: string;
}

/**
 * Embedding models.
 *
 * Each entry includes device-specific CLI args in `cpuArgs`.
 * Shared args (-m, --embedding, --port, -np, -t, --log-disable)
 * are added by the server startup code.
 */
const MODELS: ModelConfig[] = [
    {
        // nomic-embed-text-v1.5 Q8_0: 8192 token context, 768 dimensions, ~140 MB.
        // nomic-bert architecture. Requires RoPE scaling (yarn, freq scale 0.75) for full 8192 context.
        // Prefix queries with "search_query: " and documents with "search_document: ".
        name: 'nomic-embed-text-v1.5 (Q8_0)',
        url: 'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q8_0.gguf',
        sha256: '3e24342164b3d94991ba9692fdc0dd08e3fd7362e0aacc396a9a5c54a544c3b7',
        filename: 'nomic-embed-text-v1.5.Q8_0.gguf',
        dimensions: 768,
        parallelSlots: { cpu: 16 },
        cpuArgs: [
            '-c', String(16 * 2048),  // 2048 tokens/slot
            '-b', '2048', '-ub', '2048',
            '--rope-scaling', 'yarn', '--rope-freq-scale', '0.75',
        ],
        queryPrefix: 'search_query: ',
        indexPrefix: '',
    },
    {
        // nomic-embed-text-v1.5 Q4_K_M: ~50% smaller, ~2x faster than Q8_0.
        // Same architecture and flags as the Q8_0 variant.
        name: 'nomic-embed-text-v1.5 (Q4_K_M)',
        url: 'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q4_K_M.gguf',
        sha256: 'd4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac',
        filename: 'nomic-embed-text-v1.5.Q4_K_M.gguf',
        dimensions: 768,
        parallelSlots: { cpu: 16 },
        cpuArgs: [
            '-c', String(16 * 2048),  // 2048 tokens/slot
            '-b', '2048', '-ub', '2048',
            '--rope-scaling', 'yarn', '--rope-freq-scale', '0.75',
        ],
        queryPrefix: 'search_query: ',
        indexPrefix: '',
    },
    {
        // nomic-embed-code Q4_K_M: 7B code embedding model, ~4.4 GB.
        // Qwen2 decoder architecture — requires --pooling last.
        // Queries must be prefixed with "Represent this query for searching relevant code: ".
        name: 'nomic-embed-code (Q4_K_M)',
        url: 'https://huggingface.co/nomic-ai/nomic-embed-code-GGUF/resolve/main/nomic-embed-code.Q4_K_M.gguf',
        sha256: '',
        filename: 'nomic-embed-code.Q4_K_M.gguf',
        dimensions: 768,
        parallelSlots: { cpu: 2 },
        cpuArgs: [
            '-c', String(2 * 4096),   // 4096 tokens/slot
            '-b', '4096', '-ub', '4096',
            '--pooling', 'last',
        ],
        queryPrefix: 'Represent this query for searching relevant code: ',
        indexPrefix: '',
    },
    {
        // CodeRankEmbed Q4_K_M: 137M code retrieval model, ~90 MB.
        // nomic-bert architecture, trained on CoRNStack for code retrieval.
        // 8192 token context, 768 dimensions.
        // Queries must be prefixed with "Represent this query for searching relevant code: ".
        name: 'CodeRankEmbed (Q4_K_M)',
        url: 'https://huggingface.co/brandtcormorant/CodeRankEmbed-Q4_K_M-GGUF/resolve/main/coderankembed-q4_k_m.gguf',
        sha256: '',
        filename: 'coderankembed-q4_k_m.gguf',
        dimensions: 768,
        parallelSlots: { cpu: 16 },
        cpuArgs: [
            '-c', String(16 * 2048),  // 2048 tokens/slot
            '-b', '2048', '-ub', '2048',
            '--rope-scaling', 'yarn', '--rope-freq-scale', '0.75',
        ],
        queryPrefix: 'Represent this query for searching relevant code: ',
        indexPrefix: '',
    },
    {
        // CodeRankEmbed Q8_0: 137M code retrieval model, ~146 MB.
        // Higher fidelity quantization. Same nomic-bert architecture.
        // 8192 token context, 768 dimensions.
        // Queries must be prefixed with "Represent this query for searching relevant code: ".
        name: 'CodeRankEmbed (Q8_0)',
        url: 'https://huggingface.co/awhiteside/CodeRankEmbed-Q8_0-GGUF/resolve/main/coderankembed-q8_0.gguf',
        sha256: '',
        filename: 'coderankembed-q8_0.gguf',
        dimensions: 768,
        parallelSlots: { cpu: 16 },
        cpuArgs: [
            '-c', String(16 * 2048),  // 2048 tokens/slot
            '-b', '2048', '-ub', '2048',
            '--rope-scaling', 'yarn', '--rope-freq-scale', '0.75',
        ],
        queryPrefix: 'Represent this query for searching relevant code: ',
        indexPrefix: '',
    },
    {
        // jina-embeddings-v2-base-code Q8_0: 161M code embedding model, ~173 MB.
        // JinaBERT v2 architecture (ALiBi attention, no RoPE). 8192 token context, 768 dimensions.
        // Trained on github-code dataset + 150M coding Q&A pairs across 30 languages including C++.
        // Uses mean pooling — no special flags needed.
        name: 'jina-embeddings-v2-base-code (Q8_0)',
        url: 'https://huggingface.co/second-state/jina-embeddings-v2-base-code-GGUF/resolve/main/jina-embeddings-v2-base-code-Q8_0.gguf',
        sha256: '',
        filename: 'jina-embeddings-v2-base-code-Q8_0.gguf',
        dimensions: 768,
        parallelSlots: { cpu: 16 },
        cpuArgs: [
            '-c', String(16 * 4096),  // 4096 tokens/slot
            '-b', '4096', '-ub', '4096',
        ],
        queryPrefix: '',
        indexPrefix: '',
    },
    {
        // jina-code-embeddings-0.5b Q8_0: 0.5B code embedding model, ~531 MB.
        // Qwen2.5-Coder-0.5B backbone, decoder architecture — requires --pooling last.
        // 32768 token context (recommended ≤ 8192), 896 dimensions (Matryoshka: 64-896).
        // Trained on code generation data. 15+ languages including C++.
        // Uses task-specific instruction prefixes (nl2code task shown here).
        name: 'jina-code-embeddings-0.5b (Q8_0)',
        url: 'https://huggingface.co/jinaai/jina-code-embeddings-0.5b-GGUF/resolve/main/jina-code-embeddings-0.5b-Q8_0.gguf',
        sha256: '',
        filename: 'jina-code-embeddings-0.5b-Q8_0.gguf',
        dimensions: 896,
        parallelSlots: { cpu: 8 },
        cpuArgs: [
            '-c', String(4 * 4096),   // 4096 tokens/slot
            '-b', '4096', '-ub', '4096',
            '--pooling', 'last',
        ],
        queryPrefix: 'Find the most relevant code snippet given the following query:\n',
        indexPrefix: 'Candidate code snippet:\n',
    },
    {
        // jina-code-embeddings-1.5b Q8_0: 1.5B code embedding model, ~1.65 GB.
        // Qwen2.5-Coder-1.5B backbone, decoder architecture — requires --pooling last.
        // 32768 token context (recommended ≤ 8192), 1536 dimensions (Matryoshka: 128-1536).
        // SOTA on 25 code retrieval benchmarks (NeurIPS 2025). 15+ languages including C++.
        // Uses task-specific instruction prefixes (nl2code task shown here).
        name: 'jina-code-embeddings-1.5b (Q8_0)',
        url: 'https://huggingface.co/jinaai/jina-code-embeddings-1.5b-GGUF/resolve/main/jina-code-embeddings-1.5b-Q8_0.gguf',
        sha256: '',
        filename: 'jina-code-embeddings-1.5b-Q8_0.gguf',
        dimensions: 1536,
        parallelSlots: { cpu: 4 },
        cpuArgs: [
            '-c', String(4 * 4096),   // 2048 tokens/slot
            '-b', '4096', '-ub', '4096',
            '--pooling', 'last',
        ],
        queryPrefix: 'Find the most relevant code snippet given the following query:\n',
        indexPrefix: 'Candidate code snippet:\n',
    },
];

/**
 * Response from the OpenAI-compatible /v1/embeddings endpoint.
 */
interface EmbeddingResponse {
    data: { embedding: number[]; index: number }[];
}

/**
 * Response from the /health endpoint.
 */
interface HealthResponse {
    status: string;
}

/**
 * LlamaServer manages the lifecycle of a llama-server process for generating
 * embeddings. It handles model downloading, server startup/shutdown, and
 * provides an API for embedding text.
 *
 * The server supports concurrent requests via parallel slots, making it safe
 * to call embed() and embedBatch() from multiple worker threads simultaneously.
 *
 * Usage:
 *   const server = LlamaServer.getInstance();
 *   server.initialize(context);
 *   await server.start();
 *   const vector = await server.embed("some text");
 *   server.stop();
 */
export class LlamaServer {
    private serverProcess: ChildProcess | null = null;
    private port = 8384;
    private model: ModelConfig = MODELS[6];
    private parallelSlots = this.model.parallelSlots.cpu;
    private modelPath: string = '';
    private serverExePath: string = '';
    private starting = false;
    private ready = false;
    private httpAgent: http.Agent;

    constructor() {
        // Use a keep-alive agent to reuse TCP connections, reducing overhead/latency
        this.httpAgent = new http.Agent({
            keepAlive: true,
            maxSockets: 50, // Allow enough concurrent connections for slots + overhead
            keepAliveMsecs: 1000,
        });
    }

    /**
     * Initialize the server with extension context.
     * Must be called before start().
     */
    initialize(context: vscode.ExtensionContext): void {
        // Server binary is bundled with the extension
        this.serverExePath = path.join(
            context.extensionPath, 'bin', 'win_x64', 'llama.cpp', 'llama-server.exe'
        );

        // Model is stored in globalStorageUri (persists across extension updates)
        this.modelPath = path.join(
            context.globalStorageUri.fsPath, 'models', this.model.filename
        );

        log(`LlamaServer initialized (not started)`);
        log(`  Server Path: ${this.serverExePath}`);
        log(`  Model Path:  ${this.modelPath}`);
    }

    /**
     * Get the number of embedding dimensions for the current model.
     */
    getDimensions(): number {
        return this.model.dimensions;
    }

    /**
     * Get the query prefix for the current model.
     * This prefix should be prepended to user queries before embedding.
     */
    getQueryPrefix(): string {
        return this.model.queryPrefix;
    }

    /**
     * Check if the server is currently running and ready.
     */
    isReady(): boolean {
        return this.ready && this.serverProcess !== null;
    }

    /**
     * Ensure the embedding model is downloaded.
     * Prompts the user for confirmation before downloading.
     *
     * @returns true if the model is available, false if download was cancelled
     */
    async ensureModel(): Promise<boolean> {
        if (fs.existsSync(this.modelPath)) {
            log('Embedding model already present');
            return true;
        }

        // Ask user before downloading
        const choice = await vscode.window.showInformationMessage(
            `Embedding model not found. Download ${this.model.name}?`,
            'Download',
            'Cancel'
        );

        if (choice !== 'Download') {
            return false;
        }

        // Ensure models directory exists
        const modelsDir = path.dirname(this.modelPath);
        await fs.promises.mkdir(modelsDir, { recursive: true });

        // Download with progress
        const success = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Downloading ${this.model.name}...`,
            cancellable: true,
        }, async (progress, token) => {
            return this.downloadModel(progress, token);
        });

        return success;
    }

    /**
     * Download the embedding model with progress reporting.
     * Follows HTTP redirects (common with HuggingFace CDN).
     */
    private downloadModel(
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken
    ): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const tempPath = this.modelPath + '.tmp';
            const fileStream = fs.createWriteStream(tempPath);
            let cancelled = false;

            token.onCancellationRequested(() => {
                cancelled = true;
                fileStream.close();
                fs.promises.unlink(tempPath).catch(() => { });
                resolve(false);
            });

            const download = (url: string) => {
                const client = url.startsWith('https') ? https : http;
                const request = client.get(url, (response) => {
                    // Follow redirects
                    if (response.statusCode === 301 || response.statusCode === 302) {
                        const redirectUrl = response.headers.location;
                        if (redirectUrl) {
                            download(redirectUrl);
                            return;
                        }
                    }

                    if (response.statusCode !== 200) {
                        logError(`Download failed with status ${response.statusCode}`);
                        fileStream.close();
                        fs.promises.unlink(tempPath).catch(() => { });
                        resolve(false);
                        return;
                    }

                    const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
                    let downloadedBytes = 0;
                    let lastReportedPercent = 0;

                    response.pipe(fileStream);

                    response.on('data', (chunk: Buffer) => {
                        if (cancelled) return;
                        downloadedBytes += chunk.length;

                        if (totalBytes > 0) {
                            const percent = Math.floor((downloadedBytes / totalBytes) * 100);
                            if (percent > lastReportedPercent) {
                                const downloadedMB = (downloadedBytes / (1024 * 1024)).toFixed(1);
                                const totalMB = (totalBytes / (1024 * 1024)).toFixed(1);
                                progress.report({
                                    message: `${downloadedMB} / ${totalMB} MB (${percent}%)`,
                                    increment: percent - lastReportedPercent,
                                });
                                lastReportedPercent = percent;
                            }
                        }
                    });

                    fileStream.on('finish', async () => {
                        if (cancelled) return;

                        // Verify checksum if configured
                        if (this.model.sha256) {
                            progress.report({ message: 'Verifying checksum...' });
                            const valid = await this.verifyChecksum(tempPath, this.model.sha256);
                            if (!valid) {
                                logError('Model checksum verification failed');
                                await fs.promises.unlink(tempPath).catch(() => { });
                                vscode.window.showErrorMessage('Model download failed: checksum mismatch');
                                resolve(false);
                                return;
                            }
                        }

                        // Rename temp file to final path
                        await fs.promises.rename(tempPath, this.modelPath);
                        log('Model download complete');
                        resolve(true);
                    });
                });

                request.on('error', (err) => {
                    logError(`Download error: ${err.message}`);
                    fileStream.close();
                    fs.promises.unlink(tempPath).catch(() => { });
                    resolve(false);
                });
            };

            download(this.model.url);
        });
    }

    /**
     * Verify SHA256 checksum of a file.
     */
    private async verifyChecksum(filePath: string, expectedHash: string): Promise<boolean> {
        const crypto = await import('crypto');
        return new Promise((resolve) => {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);
            stream.on('data', (data) => hash.update(data));
            stream.on('end', () => {
                const actualHash = hash.digest('hex').toLowerCase();
                const expected = expectedHash.toLowerCase();
                if (actualHash !== expected) {
                    logError(`Checksum mismatch: expected ${expected}, got ${actualHash}`);
                }
                resolve(actualHash === expected);
            });
            stream.on('error', () => resolve(false));
        });
    }

    /**
     * Start the llama-server process.
     * Downloads the model if necessary, then starts the server.
     *
     * @returns true if the server started successfully
     */
    async start(): Promise<boolean> {
        if (this.ready) {
            return true;
        }

        if (this.starting) {
            // Wait for the in-progress start to complete
            return this.waitForReady(30000);
        }

        this.starting = true;

        try {
            // Verify server binary exists
            if (!fs.existsSync(this.serverExePath)) {
                logError(`llama-server not found at: ${this.serverExePath}`);
                vscode.window.showErrorMessage(
                    'llama-server binary not found.'
                );
                return false;
            }

            // Ensure model is downloaded
            const modelAvailable = await this.ensureModel();
            if (!modelAvailable) {
                log('Model not available, server not started');
                return false;
            }

            // Start server process
            log(`Starting llama-server on port ${this.port}...`);
            this.serverProcess = spawn(this.serverExePath, [
                '-m', this.modelPath,
                '--embedding',
                '--port', String(this.port),
                '-np', String(this.model.parallelSlots.cpu),
                '-t', '16',                  // Use physical cores (16 for 9950X)
                '--log-disable',
                ...this.model.cpuArgs,
            ], {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });

            this.serverProcess.on('error', (err) => {
                logError(`llama-server process error: ${err.message}`);
                this.ready = false;
            });

            this.serverProcess.on('exit', (code, signal) => {
                log(`llama-server exited (code=${code}, signal=${signal})`);
                this.ready = false;
                this.serverProcess = null;
            });

            // Capture stderr for diagnostics
            this.serverProcess.stderr?.on('data', (data: Buffer) => {
                const text = data.toString().trim();
                if (text) {
                    log(`llama-server: ${text}`);
                }
            });

            // Wait for server to become ready
            const started = await this.waitForReady(30000);
            if (started) {
                log(`llama-server started (port=${this.port}, slots=${this.parallelSlots})`);
            } else {
                logError('llama-server failed to start within timeout');
                this.stop();
            }

            return started;
        } finally {
            this.starting = false;
        }
    }

    /**
     * Wait for the server to respond to health checks.
     *
     * @param timeoutMs - Maximum time to wait in milliseconds
     * @returns true if server became ready within timeout
     */
    private async waitForReady(timeoutMs: number): Promise<boolean> {
        const startTime = Date.now();
        const pollInterval = 200;

        while (Date.now() - startTime < timeoutMs) {
            try {
                const response = await this.httpGet(`http://127.0.0.1:${this.port}/health`);
                const health = JSON.parse(response) as HealthResponse;
                if (health.status === 'ok') {
                    this.ready = true;
                    return true;
                }
            } catch {
                // Server not ready yet
            }
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        return false;
    }

    /**
     * Stop the llama-server process.
     */
    stop(): void {
        if (this.serverProcess) {
            log('Stopping llama-server...');
            this.serverProcess.kill();
            this.serverProcess = null;
        }
        this.ready = false;
    }

    /**
     * Compute the embedding vector for a single text.
     *
     * @param text - The text to embed
     * @param forIndexing - If true, prepend the model's indexPrefix instead of leaving text as-is
     * @returns The embedding vector as a Float32Array, or null on error
     */
    async embed(text: string, forIndexing?: boolean): Promise<Float32Array | null> {
        if (!this.ready) {
            warn('LlamaServer.embed() called but server is not ready');
            return null;
        }

        try {
            const input = forIndexing && this.model.indexPrefix
                ? this.model.indexPrefix + text
                : text;
            const response = await this.httpPost(
                `http://127.0.0.1:${this.port}/v1/embeddings`,
                { input }
            );

            const data = JSON.parse(response) as EmbeddingResponse;
            if (data.data && data.data.length > 0) {
                return new Float32Array(data.data[0].embedding);
            }

            logError('Unexpected embedding response format');
            return null;
        } catch (err) {
            logError(`Embedding error: ${err}`);
            return null;
        }
    }

    /**
     * Compute embedding vectors for a batch of texts.
     * Uses a concurrency pool to keep server slots saturated without
     * blocking on the slowest item (Head-of-Line blocking mitigation).
     *
     * @param texts - Array of texts to embed
     * @param forIndexing - If true, prepend the model's indexPrefix to each text
     * @returns Array of embedding vectors (Float32Array), or null on error
     */
    async embedBatch(texts: string[], forIndexing?: boolean): Promise<Float32Array[] | null> {
        if (!this.ready) {
            warn('LlamaServer.embedBatch() called but server is not ready');
            return null;
        }

        if (texts.length === 0) {
            return [];
        }

        const results: Float32Array[] = new Array(texts.length);
        let errorCount = 0;

        // Simple concurrency semaphore
        // We allow slightly more pending requests than slots to ensure
        // the server always has work queued immediately upon slot completion.
        const maxConcurrency = this.parallelSlots;
        let index = 0;
        let active = 0;

        return new Promise((resolve) => {
            const next = () => {
                // If all dispatched and all finished
                if (index >= texts.length && active === 0) {
                    if (errorCount === texts.length) resolve(null); // All failed
                    else resolve(results);
                    return;
                }

                while (active < maxConcurrency && index < texts.length) {
                    const i = index++;
                    active++;

                    this.embed(texts[i], forIndexing)
                        .then((vec) => {
                            if (vec) {
                                results[i] = vec;
                            } else {
                                errorCount++;
                            }
                        })
                        .catch(() => {
                            errorCount++;
                        })
                        .finally(() => {
                            active--;
                            next();
                        });
                }
            };

            next();
        });
    }

    /**
     * Simple HTTP GET request.
     */
    private httpGet(url: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const request = http.get(url, (response) => {
                let data = '';
                response.on('data', (chunk) => { data += chunk; });
                response.on('end', () => resolve(data));
            });
            request.on('error', reject);
            request.setTimeout(5000, () => {
                request.destroy();
                reject(new Error('Request timed out'));
            });
        });
    }

    /**
     * Simple HTTP POST request with JSON body.
     */
    private httpPost(url: string, body: object): Promise<string> {
        return new Promise((resolve, reject) => {
            const jsonBody = JSON.stringify(body);
            const options = {
                method: 'POST',
                agent: this.httpAgent,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(jsonBody),
                },
            };

            const request = http.request(url, options, (response) => {
                let data = '';
                response.on('data', (chunk) => { data += chunk; });
                response.on('end', () => {
                    if (response.statusCode === 200) {
                        resolve(data);
                    } else {
                        reject(new Error(`HTTP ${response.statusCode}: ${data}`));
                    }
                });
            });
            request.on('error', reject);
            request.setTimeout(300000, () => {
                request.destroy();
                reject(new Error('Request timed out'));
            });
            request.write(jsonBody);
            request.end();
        });
    }
}
