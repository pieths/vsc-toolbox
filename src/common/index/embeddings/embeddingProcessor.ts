// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import { FileIndex } from '../fileIndex';
import { ThreadPool } from '../workers/threadPool';
import { Chunk, ComputeChunksInput, ComputeChunksOutput } from '../types';
import { LlamaServer } from './llamaServer';
import { FileChunkInput, FileChunkRecord, VectorDatabase } from './vectorDatabase';
import { log, warn } from '../../logger';

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
    private chunksToEmbed: { filePath: string; chunk: Chunk }[] = [];
    private chunkIdsToDelete: number[] = [];
    private movedChunks: { id: number; startLine: number; endLine: number }[] = [];
    private fileVersions = new Map<string, string>();
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

        const chunks = this.chunksToEmbed.length;
        const result = await this.embedAndStore();

        if (this.vectorDatabase && this.fileVersions.size > 0) {
            const updates = Array.from(this.fileVersions, ([filePath, sha256]) => ({ filePath, sha256 }));
            await this.vectorDatabase.setFileVersions(updates);
        }

        return { chunks, vectors: result.vectors, files: result.files };
    }

    /**
     * Compute chunks for a batch of files via worker threads.
     */
    private async computeChunks(batch: FileIndex[]): Promise<ComputeChunksOutput[]> {
        const inputs: ComputeChunksInput[] = batch.map(fi => ({
            type: 'computeChunks' as const,
            filePath: fi.getFilePath(),
            idxPath: fi.getIdxPath(),
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
    private async diff(chunkOutputs: ComputeChunksOutput[]): Promise<void> {
        // Batch-fetch all stored chunks and file versions in single DB queries
        const allPaths = chunkOutputs.map(o => o.filePath);
        const storedChunksMap: Map<string, FileChunkRecord[]> = this.vectorDatabase
            ? await this.vectorDatabase.getFileChunksForMultipleFiles(allPaths)
            : new Map();
        const storedFileVersions: Map<string, string> = this.vectorDatabase
            ? await this.vectorDatabase.getFileVersions(allPaths)
            : new Map();

        for (const output of chunkOutputs) {
            if (output.error) {
                // Chunking failed (e.g. source file changed since the idx was built).
                // Purge any stored chunks for this file so stale vectors don't pollute
                // search results; the file will be re-indexed and re-embedded on the
                // next pass.
                warn(`Content index: Chunk error for ${output.filePath}: ${output.error}`);
                const staleChunks = storedChunksMap.get(output.filePath) ?? [];
                for (const stored of staleChunks) {
                    this.chunkIdsToDelete.push(stored.id);
                }
                this.fileVersions.set(output.filePath, '');
                continue;
            }

            const storedChunks = storedChunksMap.get(output.filePath) ?? [];

            const storedByHash = new Map(storedChunks.map(s => [s.sha256, s]));
            const newHashes = new Set(output.chunks.map(c => c.sha256));

            let fileChanged = false;

            // Delete stored chunks that no longer exist in the new output
            for (const [hash, stored] of storedByHash) {
                if (!newHashes.has(hash)) {
                    this.chunkIdsToDelete.push(stored.id);
                    fileChanged = true;
                }
            }

            // Queue new chunks that don't already exist in the database
            for (const chunk of output.chunks) {
                if (!storedByHash.has(chunk.sha256)) {
                    this.chunksToEmbed.push({ filePath: output.filePath, chunk });
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

            // Queue a file version update if the source
            // sha256 differs from what's stored
            const storedSha256 = storedFileVersions.get(output.filePath);
            const newSha256 = output.sha256 ?? '';
            if (storedSha256 !== newSha256) {
                this.fileVersions.set(output.filePath, newSha256);
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
        if (this.vectorDatabase && this.chunkIdsToDelete.length > 0) {
            await this.vectorDatabase.deleteFileChunks(this.chunkIdsToDelete);
        }

        if (this.vectorDatabase && this.movedChunks.length > 0) {
            await this.vectorDatabase.updateFileChunkLines(this.movedChunks);
        }

        if (this.chunksToEmbed.length === 0) {
            return { vectors: 0, files: 0 };
        }

        const texts = this.chunksToEmbed.map(m => m.chunk.text);
        const vectors = await this.llamaServer.embedBatch(texts, true);

        if (!vectors) {
            warn(`Content index: Failed to embed batch of ${texts.length} chunks`);
            return { vectors: 0, files: 0 };
        }

        const newChunks: FileChunkInput[] = [];
        let failedCount = 0;

        for (let i = 0; i < vectors.length; i++) {
            if (!vectors[i]) {
                failedCount++;
                // Blank the file version for this file so we don't claim
                // valid chunks when some embeddings failed
                const failedPath = this.chunksToEmbed[i].filePath;
                this.fileVersions.set(failedPath, '');
                continue;
            }
            const m = this.chunksToEmbed[i];
            newChunks.push({
                filePath: m.filePath,
                startLine: m.chunk.startLine,
                endLine: m.chunk.endLine,
                sha256: m.chunk.sha256,
                vector: vectors[i],
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
        this.chunksToEmbed = [];
        this.chunkIdsToDelete = [];
        this.movedChunks = [];
        this.fileVersions.clear();
        this.changedFilePaths.clear();
    }
}
