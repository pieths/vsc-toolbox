// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import { FileRef } from '../fileRef';
import { ThreadPool } from '../workers/threadPool';
import { Chunk, ComputeChunksInput, ComputeChunksOutput, ComputeChunksStatus } from '../types';
import { LlamaServer } from './llamaServer';
import { FileChunkInput, FileChunkRecord, VectorDatabase } from './vectorDatabase';
import { log, warn } from '../../logger';

/**
 * Method-object that encapsulates the embedding pipeline for a set of files.
 *
 * Files are processed in small batches (chunking + diffing), and the diff
 * state is accumulated across batches.  When the total pending work reaches
 * a threshold (or no more files remain), the accumulated changes are flushed
 * to the database in one pass — minimising the number of LanceDB versions
 * created.
 *
 * Flush performs:
 *   1. Embed all changed chunk texts in a single embedBatch call.
 *   2. Delete stale stored chunks in a single deleteFileChunks call.
 *   3. Insert new chunks in a single addFileChunks call.
 *   4. Update file versions in a single setFileVersions call.
 */
export class EmbeddingProcessor {
    private readonly batchSize = 50;
    private readonly flushThreshold = 300;

    // Accumulated diff state (reset on flush)
    private chunksToEmbed: { filePath: string; chunk: Chunk }[] = [];
    private chunkIdsToDelete: number[] = [];
    private movedChunks: FileChunkRecord[] = [];
    private fileVersionUpdates = new Map<string, string>();
    private changedFilePaths = new Set<string>();

    // Per-run state (set once at start of run, cleared at end)
    private storedFileVersions = new Map<string, string>();

    constructor(
        private readonly vectorDatabase: VectorDatabase | null,
        private readonly llamaServer: LlamaServer,
        private readonly threadPool: ThreadPool,
    ) { }

    /**
     * Process all files: compute chunks, diff, embed, and persist.
     */
    async run(files: FileRef[]): Promise<void> {
        const startTime = Date.now();
        let totalChunks = 0;
        let totalVectors = 0;
        let totalFiles = 0;

        // Deduplicate by file path to prevent double-processing
        const seen = new Set<string>();
        files = files.filter(fi => {
            const key = fi.getFilePath();
            if (seen.has(key)) { return false; }
            seen.add(key);
            return true;
        });

        log(`Content index: Starting embedding for ${files.length} files`);

        // Fetch stored file versions once for the entire run — shared by
        // computeChunks (for early skip) and diff (for version comparison).
        // Safe because each file appears in exactly one batch (deduped above).
        const allPaths = files.map(fi => fi.getFilePath());
        this.storedFileVersions = this.vectorDatabase
            ? await this.vectorDatabase.getFileVersions(allPaths)
            : new Map();

        const recentBatchDurations: number[] = [];

        for (let i = 0; i < files.length; i += this.batchSize) {
            const batch = files.slice(i, i + this.batchSize);
            const batchStart = Date.now();

            try {
                await this.processBatch(batch);
            } catch (err) {
                warn(`Content index: Batch failed (files ${i + 1}–${Math.min(i + this.batchSize, files.length)}): ${err}`);
            }

            const moreFilesToProcess = (i + this.batchSize) < files.length;
            const pendingWork = this.chunksToEmbed.length;

            if (pendingWork >= this.flushThreshold || !moreFilesToProcess) {
                try {
                    const result = await this.flush();
                    totalChunks += result.chunks;
                    totalVectors += result.vectors;
                    totalFiles += result.files;
                } catch (err) {
                    warn(`Content index: Flush failed: ${err}`);
                } finally {
                    this.resetDiff();
                }
            }

            recentBatchDurations.push(Date.now() - batchStart);
            if (recentBatchDurations.length > 10) {
                recentBatchDurations.shift();
            }

            const processed = Math.min(i + this.batchSize, files.length);
            const remainingBatches = Math.ceil((files.length - processed) / this.batchSize);
            const eta = this.formatTimeRemaining(recentBatchDurations, remainingBatches);
            log(`Content index: Embedding progress: ${processed}/${files.length} files${eta}`);
        }

        const elapsed = Date.now() - startTime;
        log(`Content index: Embedding complete: ${totalVectors} vectors from ${totalChunks} chunks across ${totalFiles} files in ${elapsed}ms`);

        this.storedFileVersions.clear();
    }

    /**
     * Process a single batch: compute chunks and diff against the database.
     *
     * The diff state is accumulated across batches and flushed by the
     * caller when a threshold is reached or no more files remain.
     */
    private async processBatch(batch: FileRef[]): Promise<void> {
        const chunkOutputs = await this.computeChunks(batch);

        // Filter out skipped files — their chunks and versions are already
        // up-to-date in the database, so diff doesn't need to see them.
        const activeOutputs = chunkOutputs.filter(o => o.status !== ComputeChunksStatus.Skipped);
        if (activeOutputs.length === 0) {
            return;
        }
        await this.diff(activeOutputs);
    }

    /**
     * Flush accumulated diff state: embed, persist to the database,
     * and update file versions.
     */
    private async flush(): Promise<{ chunks: number; vectors: number; files: number }> {
        const chunks = this.chunksToEmbed.length;
        const result = await this.embedAndStore();

        if (this.vectorDatabase && this.fileVersionUpdates.size > 0) {
            const updates = Array.from(this.fileVersionUpdates, ([filePath, sha256]) => ({ filePath, sha256 }));
            await this.vectorDatabase.setFileVersions(updates);
        }

        return { chunks, vectors: result.vectors, files: result.files };
    }

    /**
     * Compute chunks for a batch of files via worker threads.
     */
    private async computeChunks(batch: FileRef[]): Promise<ComputeChunksOutput[]> {
        const inputs: ComputeChunksInput[] = batch.map(fi => ({
            type: 'computeChunks' as const,
            filePath: fi.getFilePath(),
            idxPath: fi.getIdxPath(),
            storedSha256: this.storedFileVersions.get(fi.getFilePath()),
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
        // Batch-fetch stored chunks in a single DB query
        const allPaths = chunkOutputs.map(o => o.filePath);
        const storedChunksMap: Map<string, FileChunkRecord[]> = this.vectorDatabase
            ? await this.vectorDatabase.getFileChunksForMultipleFiles(allPaths)
            : new Map();

        for (const output of chunkOutputs) {
            if (output.status === ComputeChunksStatus.Error) {
                // Chunking failed (e.g. source file changed since the idx was built).
                // Purge any stored chunks for this file so stale vectors don't pollute
                // search results; the file will be re-indexed and re-embedded on the
                // next pass.
                warn(`Content index: Chunk error for ${output.filePath}: ${output.error}`);
                const staleChunks = storedChunksMap.get(output.filePath) ?? [];
                for (const stored of staleChunks) {
                    this.chunkIdsToDelete.push(stored.id);
                }
                this.fileVersionUpdates.set(output.filePath, '');
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
                    stored.startLine = chunk.startLine;
                    stored.endLine = chunk.endLine;
                    this.movedChunks.push(stored);
                    fileChanged = true;
                }
            }

            if (fileChanged) {
                this.changedFilePaths.add(output.filePath);
            }

            // Queue a file version update if the source
            // sha256 differs from what's stored
            const storedSha256 = this.storedFileVersions.get(output.filePath);
            const newSha256 = output.sha256 ?? '';
            if (storedSha256 !== newSha256) {
                this.fileVersionUpdates.set(output.filePath, newSha256);
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
            for (const m of this.chunksToEmbed) {
                warn(`  Failed chunk: ${m.filePath}:${m.chunk.startLine}-${m.chunk.endLine}`);
            }
            return { vectors: 0, files: 0 };
        }

        const newChunks: FileChunkInput[] = [];
        let failedCount = 0;

        for (let i = 0; i < vectors.length; i++) {
            if (!vectors[i]) {
                failedCount++;
                // Blank the file version for this file so we don't mark
                // that all chunks are valid when some embeddings failed.
                const failed = this.chunksToEmbed[i];
                warn(`Content index: Embedding failed for ${failed.filePath}:${failed.chunk.startLine}-${failed.chunk.endLine}`);
                this.fileVersionUpdates.set(failed.filePath, '');
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
     * Estimate the time remaining based on recent batch durations.
     *
     * Uses a rolling average of the most recent batch durations to
     * extrapolate how long the remaining batches will take.
     *
     * @returns A formatted string like " (~2m 30s remaining)", or empty
     *          string if no batches remaining.
     */
    private formatTimeRemaining(recentDurations: number[], remainingBatches: number): string {
        if (remainingBatches <= 0 || recentDurations.length === 0) {
            return '';
        }
        const avgMs = recentDurations.reduce((a, b) => a + b, 0) / recentDurations.length;
        const remainingMs = avgMs * remainingBatches;
        const totalSeconds = Math.ceil(remainingMs / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        if (minutes > 0) {
            return ` (~${minutes}m ${seconds}s remaining)`;
        }
        return ` (~${seconds}s remaining)`;
    }

    /**
     * Reset diff state for the next flush cycle.
     */
    private resetDiff(): void {
        this.chunksToEmbed = [];
        this.chunkIdsToDelete = [];
        this.movedChunks = [];
        this.fileVersionUpdates.clear();
        this.changedFilePaths.clear();
    }
}
