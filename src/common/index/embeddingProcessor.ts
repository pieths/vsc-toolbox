// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import { FileIndex } from './fileIndex';
import { ThreadPool } from './threadPool';
import { Chunk, ComputeChunksInput } from './types';
import { LlamaServer } from './llamaServer';
import { VectorDatabase } from './vectorDatabase';
import { log, warn } from '../logger';

/**
 * Method-object that encapsulates the embedding pipeline for a set of files.
 *
 * For each batch of files the flow is:
 *   1. Compute chunks via worker threads.
 *   2. Diff each file's chunks against the database — collect only chunks
 *      whose SHA-256 values differ (or that are new).
 *   3. Embed all changed chunk texts in a single embedBatch call.
 *   4. Delete stale stored chunks in a single deleteFileChunks call.
 *   5. Insert new chunks in a single addFileChunks call.
 */
export class EmbeddingProcessor {
    private readonly batchSize = 50;

    // Accumulated diff state (reset per batch)
    private texts: string[] = [];
    private meta: { filePath: string; chunk: Chunk }[] = [];
    private idsToDelete: number[] = [];
    private movedChunks: { id: number; startLine: number; endLine: number }[] = [];
    private changedFilePaths = new Set<string>();

    constructor(
        private readonly vectorDatabase: VectorDatabase | null,
        private readonly llamaServer: LlamaServer,
        private readonly threadPool: ThreadPool,
    ) { }

    /**
     * Process all files: compute chunks, diff, embed, and persist.
     */
    async run(files: FileIndex[]): Promise<void> {
        const startTime = Date.now();
        let totalChunks = 0;
        let totalVectors = 0;
        let totalFiles = 0;

        log(`Content index: Starting embedding for ${files.length} files`);

        for (let i = 0; i < files.length; i += this.batchSize) {
            const batch = files.slice(i, i + this.batchSize);

            try {
                const result = await this.processBatch(batch);
                totalChunks += result.chunks;
                totalVectors += result.vectors;
                totalFiles += result.files;
            } catch (err) {
                warn(`Content index: Batch failed (files ${i + 1}–${Math.min(i + this.batchSize, files.length)}): ${err}`);
            } finally {
                this.resetDiff();
            }

            log(`Content index: Embedding progress: ${Math.min(i + this.batchSize, files.length)}/${files.length} files`);
        }

        const elapsed = Date.now() - startTime;
        log(`Content index: Embedding complete: ${totalVectors} vectors from ${totalChunks} chunks across ${totalFiles} files in ${elapsed}ms`);
    }

    /**
     * Process a single batch: compute chunks, diff, embed, and persist.
     */
    private async processBatch(batch: FileIndex[]): Promise<{ chunks: number; vectors: number; files: number }> {
        const chunkOutputs = await this.computeChunks(batch);
        await this.diff(chunkOutputs);

        const chunks = this.texts.length;
        const result = await this.embedAndStore();
        return { chunks, vectors: result.vectors, files: result.files };
    }

    /**
     * Compute chunks for a batch of files via worker threads.
     */
    private async computeChunks(batch: FileIndex[]): Promise<{ filePath: string; chunks: Chunk[]; error?: string }[]> {
        const inputs: ComputeChunksInput[] = batch.map(fi => ({
            type: 'computeChunks' as const,
            filePath: fi.getFilePath(),
            ctagsPath: fi.getTagsPath(),
        }));

        return this.threadPool.computeChunksAll(inputs);
    }

    /**
     * Compare chunk outputs against the database and populate the diff fields.
     *
     * For each file, builds a set of stored SHA-256 hashes and a set of new
     * SHA-256 hashes, then:
     *  - Stored chunks whose hash is NOT in the new set are marked for deletion.
     *  - New chunks whose hash is NOT in the stored set are queued for embedding.
     *  - Chunks present in both sets whose line numbers differ are queued for
     *    a metadata-only update (no re-embedding needed).
     */
    private async diff(chunkOutputs: { filePath: string; chunks: Chunk[]; error?: string }[]): Promise<void> {
        for (const output of chunkOutputs) {
            if (output.error) {
                warn(`Content index: Chunk error for ${output.filePath}: ${output.error}`);
                continue;
            }

            const storedChunks = this.vectorDatabase
                ? await this.vectorDatabase.getFileChunksByFilePath(output.filePath)
                : [];

            const storedByHash = new Map(storedChunks.map(s => [s.sha256, s]));
            const newHashes = new Set(output.chunks.map(c => c.sha256));

            let fileChanged = false;

            // Delete stored chunks that no longer exist in the new output
            for (const [hash, stored] of storedByHash) {
                if (!newHashes.has(hash)) {
                    this.idsToDelete.push(stored.id);
                    fileChanged = true;
                }
            }

            // Queue new chunks that don't already exist in the database
            for (const chunk of output.chunks) {
                if (!storedByHash.has(chunk.sha256)) {
                    this.texts.push(chunk.text);
                    this.meta.push({ filePath: output.filePath, chunk });
                    fileChanged = true;
                }
            }

            // Detect chunks that moved (same sha256 but different line numbers)
            for (const chunk of output.chunks) {
                const stored = storedByHash.get(chunk.sha256);
                if (stored && (stored.startLine !== chunk.startLine || stored.endLine !== chunk.endLine)) {
                    this.movedChunks.push({ id: stored.id, startLine: chunk.startLine, endLine: chunk.endLine });
                    fileChanged = true;
                }
            }

            if (fileChanged) {
                this.changedFilePaths.add(output.filePath);
            }
        }
    }

    /**
     * Embed the collected texts and persist changes to the database.
     *
     * Performs a single embedBatch call, a single deleteFileChunks call
     * (for stale chunks), and a single addFileChunks call (for new ones).
     */
    private async embedAndStore(): Promise<{ vectors: number; files: number }> {
        if (this.vectorDatabase && this.idsToDelete.length > 0) {
            await this.vectorDatabase.deleteFileChunks(this.idsToDelete);
        }

        if (this.vectorDatabase && this.movedChunks.length > 0) {
            await this.vectorDatabase.updateFileChunkLines(this.movedChunks);
        }

        if (this.texts.length === 0) {
            return { vectors: 0, files: 0 };
        }

        const vectors = await this.llamaServer.embedBatch(this.texts, true);

        if (!vectors) {
            warn(`Content index: Failed to embed batch of ${this.texts.length} chunks`);
            return { vectors: 0, files: 0 };
        }

        const newChunks: { filePath: string; startLine: number; endLine: number; sha256: string; vector: Float32Array }[] = [];
        let failedCount = 0;

        for (let j = 0; j < vectors.length; j++) {
            if (!vectors[j]) {
                failedCount++;
                continue;
            }
            const m = this.meta[j];
            newChunks.push({
                filePath: m.filePath,
                startLine: m.chunk.startLine,
                endLine: m.chunk.endLine,
                sha256: m.chunk.sha256,
                vector: vectors[j],
            });
        }

        if (failedCount > 0) {
            warn(`Content index: ${failedCount}/${vectors.length} embeddings failed`);
        }

        if (this.vectorDatabase && newChunks.length > 0) {
            await this.vectorDatabase.addFileChunks(newChunks);
        }

        return { vectors: newChunks.length, files: this.changedFilePaths.size };
    }

    /**
     * Reset diff state for the next batch.
     */
    private resetDiff(): void {
        this.texts = [];
        this.meta = [];
        this.idsToDelete = [];
        this.movedChunks = [];
        this.changedFilePaths.clear();
    }
}
