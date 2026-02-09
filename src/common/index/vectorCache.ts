// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * VectorCache — in-memory embedding vector store backed by a single
 * SharedArrayBuffer.
 *
 * Design goals:
 *  - All vectors live in one contiguous SharedArrayBuffer so worker threads
 *    can scan them in parallel with zero-copy reads.
 *  - Append-only writes; deleted/updated files leave dead slots that are
 *    reclaimed by compaction.
 *  - In-place slot reuse when a file is re-indexed with the same or fewer
 *    chunks, avoiding dead gaps in the common edit-within-a-chunk case.
 *  - Per-file metadata groups all of a file's vectors under a single
 *    `FileVectorEntries` object (one filePath string, one ranges array)
 *    so there is zero per-slot string duplication.
 *  - Zero-copy persistence: save() streams vector data directly from the SAB
 *    via lightweight Uint8Array views, and load() reads directly into the SAB
 *    via fileHandle.read() — no temporary heap-sized buffers are allocated.
 *
 * Memory layout of the SharedArrayBuffer (Float32 view):
 *   [ vector_0 (dims floats) | vector_1 (dims floats) | ... | vector_N ]
 *
 * Each vector slot is exactly `dims` floats wide (e.g. 768 × 4 = 3072 bytes).
 * A file's vectors always occupy a contiguous run of slots.
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Constants ───────────────────────────────────────────────────────────────

/** Default embedding dimensionality (nomic-embed-text-v1.5) */
const DEFAULT_DIMS = 768;

/** Bytes per float32 */
const BYTES_PER_FLOAT = 4;

/** Initial capacity in number of vector slots */
const DEFAULT_INITIAL_CAPACITY = 400000;

/** Growth factor when the buffer is full */
const GROWTH_FACTOR = 1.2;

/**
 * Version tag written at the start of persisted files so we can detect
 * format changes and refuse to load incompatible caches.
 */
const PERSIST_VERSION = 1;

// ── Types ───────────────────────────────────────────────────────────────────

/** Line range that a single embedded chunk spans. */
export interface LineRange {
    /** First line of the source range (1-based) */
    startLine: number;
    /** Last line of the source range (1-based, inclusive) */
    endLine: number;
}

/**
 * Per-file grouping of vector metadata.
 *
 * A file's vectors always occupy a contiguous run of slots in the SAB:
 *   slots [startSlot, startSlot + ranges.length)
 *
 * `ranges[i]` corresponds to SAB slot `startSlot + i`.
 */
export interface FileVectorEntries {
    /** Absolute path of the source file */
    filePath: string;
    /** Index of the first slot in the SAB belonging to this file */
    startSlot: number;
    /** Line ranges for each vector (index 0 → startSlot, index 1 → startSlot+1, …) */
    ranges: LineRange[];
}

/** Serialisable representation of the metadata map (for persistence). */
interface PersistedMetadata {
    version: number;
    dims: number;
    /** Total number of slots (all live after compaction) */
    totalSlots: number;
    /**
     * Per-file entries, ordered to match the SAB layout.
     * The first file's vectors occupy slots [0, files[0].ranges.length),
     * the second file's vectors follow immediately after, and so on.
     */
    files: PersistedFileEntry[];
}

/** Single file in the persisted metadata. */
interface PersistedFileEntry {
    /** Absolute path */
    filePath: string;
    /** [startLine, endLine] tuples — one per vector, in slot order */
    ranges: [number, number][];
}

// ── VectorCache ─────────────────────────────────────────────────────────────

export class VectorCache {
    /** Directory used for persistence (vectors.bin + metadata.json) */
    private readonly dir: string;

    /** Path to the raw vector data file */
    private readonly vectorsPath: string;

    /** Path to the metadata JSON file */
    private readonly metadataPath: string;

    /** Embedding dimensionality (floats per vector) */
    private readonly embeddingDims: number;

    /** The shared buffer that holds all vectors contiguously */
    private sab: SharedArrayBuffer;

    /** Float32 view over sab for reading/writing vector data */
    private vectors: Float32Array;

    /** Current write cursor — index of the next free slot */
    private cursor: number = 0;

    /** Total number of slots the buffer can hold at its current size */
    private slotCapacity: number;

    /**
     * Per-file metadata. Each value groups a file's slot range
     * and line ranges under a single object.
     */
    private fileEntries: Map<string, FileVectorEntries> = new Map();

    /**
     * Per-slot reverse lookup into fileEntries.
     * `slotOwner[i]` points to the FileVectorEntries that owns slot `i`,
     * or `null` if the slot is dead.
     */
    private slotOwner: (FileVectorEntries | null)[] = [];

    /** Number of live (non-null) slots */
    private liveEntryCount: number = 0;

    // ── Construction ────────────────────────────────────────────────────────

    /**
     * Create a new VectorCache.
     *
     * @param dir        Directory for persistence (vectors.bin + vectors_metadata.json)
     * @param dims       Embedding dimensionality (default 768)
     * @param capacity   Initial number of vector slots to allocate
     */
    constructor(dir: string, dims: number = DEFAULT_DIMS, capacity: number = DEFAULT_INITIAL_CAPACITY) {
        this.dir = dir;
        this.vectorsPath = path.join(dir, 'vectors.bin');
        this.metadataPath = path.join(dir, 'vectors_metadata.json');
        this.embeddingDims = dims;
        this.slotCapacity = capacity;
        this.sab = new SharedArrayBuffer(capacity * dims * BYTES_PER_FLOAT);
        this.vectors = new Float32Array(this.sab);
    }

    // ── Public accessors ────────────────────────────────────────────────────

    /** The SharedArrayBuffer — pass this to worker threads. */
    get buffer(): SharedArrayBuffer {
        return this.sab;
    }

    /** Embedding dimensionality. */
    get dims(): number {
        return this.embeddingDims;
    }

    /** Number of live vectors currently in the cache. */
    get liveCount(): number {
        return this.liveEntryCount;
    }

    /** Total slots written (including dead). Equals the write cursor position. */
    get totalSlots(): number {
        return this.cursor;
    }

    /** Current capacity in number of slots. */
    get capacity(): number {
        return this.slotCapacity;
    }

    // ── Add / delete ────────────────────────────────────────────────────────

    /**
     * Add vectors for a file's chunks. If the file already has vectors in the
     * cache they are removed first (full replacement).
     *
     * @param filePath  Absolute path of the source file
     * @param ranges    Line ranges that were embedded (one per vector)
     * @param vectors   Array of embedding vectors, one Float32Array per range (each must be `dims` floats)
     * @returns         The slot index of the first vector written
     */
    add(filePath: string, ranges: LineRange[], vectors: Float32Array[]): number {
        if (vectors.length !== ranges.length) {
            throw new Error(
                `Count mismatch: ${ranges.length} ranges but ${vectors.length} vectors`
            );
        }

        const slotsNeeded = ranges.length;
        const existing = this.fileEntries.get(filePath);

        // Fast path: reuse existing slots in-place when the new count fits.
        // This avoids creating dead gaps when a file is re-indexed with the
        // same (or fewer) chunks — the common case for edits within a chunk.
        if (existing && slotsNeeded <= existing.ranges.length) {
            const oldCount = existing.ranges.length;
            const startSlot = existing.startSlot;

            // Overwrite vector data with new vectors
            for (let i = 0; i < slotsNeeded; i++) {
                const vec = vectors[i];
                if (vec.length !== this.embeddingDims) {
                    throw new Error(
                        `Vector ${i} length mismatch: expected ${this.embeddingDims} floats, got ${vec.length}`
                    );
                }
                const dstOffset = (startSlot + i) * this.embeddingDims;
                this.vectors.set(vec, dstOffset);
            }

            // Mark any trailing slots as dead
            for (let i = slotsNeeded; i < oldCount; i++) {
                this.slotOwner[startSlot + i] = null;
            }
            this.liveEntryCount -= (oldCount - slotsNeeded);

            // Update the entry in-place
            existing.ranges = ranges.slice();

            return startSlot;
        }

        // Slow path: delete old entry (if any) and append at the cursor.
        this.deleteFile(filePath);

        // Grow if needed
        this.ensureCapacity(this.cursor + slotsNeeded);

        const startSlot = this.cursor;

        // Create the per-file entry (single filePath string, one ranges array)
        const fileEntry: FileVectorEntries = {
            filePath,
            startSlot,
            ranges: ranges.slice(),  // own copy so caller can't mutate
        };

        // Copy each vector into the SAB and set slot owners
        for (let i = 0; i < slotsNeeded; i++) {
            const vec = vectors[i];
            if (vec.length !== this.embeddingDims) {
                throw new Error(
                    `Vector ${i} length mismatch: expected ${this.embeddingDims} floats, got ${vec.length}`
                );
            }
            const dstOffset = (startSlot + i) * this.embeddingDims;
            this.vectors.set(vec, dstOffset);
            this.slotOwner[startSlot + i] = fileEntry;
        }

        this.cursor += slotsNeeded;
        this.liveEntryCount += slotsNeeded;
        this.fileEntries.set(filePath, fileEntry);

        return startSlot;
    }

    /**
     * Remove all vectors belonging to a file. The vector data remains in the
     * SharedArrayBuffer (it is not zeroed out) but the slot owner references
     * are cleared so the slots are treated as dead. Reclaim the space by
     * calling `compact()`.
     *
     * @param filePath  Absolute path of the file to remove
     * @returns         Number of slots freed
     */
    deleteFile(filePath: string): number {
        const fileEntry = this.fileEntries.get(filePath);
        if (!fileEntry) {
            return 0;
        }

        const count = fileEntry.ranges.length;
        for (let i = 0; i < count; i++) {
            this.slotOwner[fileEntry.startSlot + i] = null;
        }

        this.liveEntryCount -= count;
        this.fileEntries.delete(filePath);
        return count;
    }

    /**
     * Check whether vectors exist for a file.
     */
    hasFile(filePath: string): boolean {
        return this.fileEntries.has(filePath);
    }

    /**
     * Get the file entry and line range for a given slot index,
     * or null if the slot is dead.
     */
    getSlotEntry(slotIndex: number): { fileEntry: FileVectorEntries; range: LineRange } | null {
        const owner = this.slotOwner[slotIndex];
        if (!owner) {
            return null;
        }
        const rangeIndex = slotIndex - owner.startSlot;
        return { fileEntry: owner, range: owner.ranges[rangeIndex] };
    }

    /**
     * Get the per-file vector entries for a file.
     */
    getFileEntry(filePath: string): FileVectorEntries | undefined {
        return this.fileEntries.get(filePath);
    }

    /**
     * Return the set of all file paths that have vectors in the cache.
     */
    getFilePaths(): IterableIterator<string> {
        return this.fileEntries.keys();
    }

    // ── Persistence ─────────────────────────────────────────────────────────

    /**
     * Write the cache to disk.  Two files are created:
     *   <dir>/vectors.bin   — raw Float32 vector data (only live slots, compacted)
     *   <dir>/vectors_metadata.json — metadata map + housekeeping
     *
     * The save is compacted: dead slots are removed and surviving vectors are
     * packed contiguously. This means the on-disk representation is always
     * minimal, and loading it back produces a clean cache with no fragmentation.
     *
     */
    async save(): Promise<void> {
        await fs.promises.mkdir(this.dir, { recursive: true });

        // Write vector data directly from the SAB — one write per file's
        // contiguous slot run.  Each Uint8Array view is ~64 bytes; no
        // full-size intermediate buffer is allocated.
        const files: PersistedFileEntry[] = [];
        let totalSlots = 0;

        const fh = await fs.promises.open(this.vectorsPath, 'w');
        try {
            for (const fileEntry of this.fileEntries.values()) {
                const byteOffset = fileEntry.startSlot * this.embeddingDims * BYTES_PER_FLOAT;
                const byteLength = fileEntry.ranges.length * this.embeddingDims * BYTES_PER_FLOAT;
                const view = new Uint8Array(this.sab, byteOffset, byteLength);
                await fh.write(view);

                files.push({
                    filePath: fileEntry.filePath,
                    ranges: fileEntry.ranges.map(r => [r.startLine, r.endLine]),
                });

                totalSlots += fileEntry.ranges.length;
            }
        } finally {
            await fh.close();
        }

        const metadata: PersistedMetadata = {
            version: PERSIST_VERSION,
            dims: this.embeddingDims,
            totalSlots,
            files,
        };

        // Metadata written last so it acts as a commit marker
        await fs.promises.writeFile(this.metadataPath, JSON.stringify(metadata));
    }

    /**
     * Read a file directly into a SharedArrayBuffer, avoiding a temporary
     * heap-allocated copy. Uses `fileHandle.read()` with a Uint8Array view
     * over the SAB so the OS reads straight into shared memory.
     *
     * @param filePath       Path to the file to read
     * @param sab            Target SharedArrayBuffer (must be large enough)
     * @param expectedBytes  Exact number of bytes the file must contain
     * @returns              true on success, false if the file size doesn't match
     */
    private static async readFileIntoSab(
        filePath: string,
        sab: SharedArrayBuffer,
        expectedBytes: number,
    ): Promise<boolean> {
        const fh = await fs.promises.open(filePath, 'r');
        try {
            const stat = await fh.stat();
            if (stat.size !== expectedBytes) {
                return false;
            }
            const view = new Uint8Array(sab, 0, expectedBytes);
            const { bytesRead } = await fh.read(view, 0, expectedBytes, 0);
            return bytesRead === expectedBytes;
        } finally {
            await fh.close();
        }
    }

    /**
     * Load a previously saved cache from disk. Returns a new VectorCache
     * instance. If the files don't exist or are incompatible, returns null.
     *
     * @param dir   Directory that contains vectors.bin and metadata.json
     * @param dims  Expected embedding dimensionality (must match persisted data)
     * @returns     A populated VectorCache, or null if loading failed
     */
    static async load(dir: string, dims: number = DEFAULT_DIMS): Promise<VectorCache | null> {
        try {
            // Read metadata first to validate before allocating memory
            const metadataPath = path.join(dir, 'vectors_metadata.json');
            const metadataRaw = await fs.promises.readFile(metadataPath, 'utf8');
            const metadata: PersistedMetadata = JSON.parse(metadataRaw);

            if (metadata.version !== PERSIST_VERSION) {
                return null;
            }
            if (metadata.dims !== dims) {
                return null;
            }

            const expectedVectorBytes = metadata.totalSlots * dims * BYTES_PER_FLOAT;

            // Create cache with enough capacity (add headroom for new vectors)
            const capacity = Math.max(metadata.totalSlots * GROWTH_FACTOR, DEFAULT_INITIAL_CAPACITY);
            const cache = new VectorCache(dir, dims, capacity);

            // Read vector data directly into the SAB (no intermediate buffer)
            const ok = await VectorCache.readFileIntoSab(cache.vectorsPath, cache.sab, expectedVectorBytes);
            if (!ok) {
                return null;
            }

            // Rebuild per-file entries and slot owners.
            // The persisted file is already compacted so files are packed
            // contiguously in the order they appear in metadata.files.
            let slot = 0;
            for (const pf of metadata.files) {
                const ranges: LineRange[] = pf.ranges.map(
                    ([startLine, endLine]) => ({ startLine, endLine }),
                );

                const fileEntry: FileVectorEntries = {
                    filePath: pf.filePath,
                    startSlot: slot,
                    ranges,
                };

                for (let i = 0; i < ranges.length; i++) {
                    cache.slotOwner[slot + i] = fileEntry;
                }

                cache.fileEntries.set(pf.filePath, fileEntry);
                cache.liveEntryCount += ranges.length;
                slot += ranges.length;
            }

            cache.cursor = slot;

            return cache;
        } catch {
            return null;
        }
    }

    // ── Compaction ───────────────────────────────────────────────────────────

    /**
     * Compact the cache in-place: remove dead slots and pack surviving vectors
     * contiguously. This reclaims fragmented space without reallocating the
     * SharedArrayBuffer.
     *
     * IMPORTANT: Do not call this while worker threads are reading the buffer.
     * Coordinate with the thread pool to ensure no searches are in flight.
     *
     * @returns  The number of slots reclaimed
     */
    compact(): number {
        if (this.liveEntryCount === this.cursor) {
            return 0; // already compact
        }

        const reclaimed = this.cursor - this.liveEntryCount;

        // Pack each live file's vectors contiguously, skipping dead gaps.
        let writeSlot = 0;

        for (const fileEntry of this.fileEntries.values()) {
            const count = fileEntry.ranges.length;

            if (writeSlot !== fileEntry.startSlot) {
                // Move vector data
                const srcOffset = fileEntry.startSlot * this.embeddingDims;
                const dstOffset = writeSlot * this.embeddingDims;
                const floatCount = count * this.embeddingDims;
                this.vectors.copyWithin(dstOffset, srcOffset, srcOffset + floatCount);

                // Update slot owners to point to new positions
                for (let i = 0; i < count; i++) {
                    this.slotOwner[writeSlot + i] = fileEntry;
                }

                fileEntry.startSlot = writeSlot;
            }

            writeSlot += count;
        }

        // Clear trailing slot owners
        this.slotOwner.length = writeSlot;
        this.cursor = writeSlot;

        return reclaimed;
    }

    /**
     * Ratio of dead slots to total slots (0–1).
     * Useful for deciding when to trigger compaction.
     */
    get fragmentation(): number {
        if (this.cursor === 0) return 0;
        return 1 - this.liveEntryCount / this.cursor;
    }

    /** Total bytes allocated for the SAB (includes live, dead, and free slots). */
    get allocatedBytes(): number {
        return this.sab.byteLength;
    }

    // ── Private helpers ─────────────────────────────────────────────────────

    /**
     * Ensure the SAB has room for at least `requiredSlots` total slots.
     * If not, allocate a new larger SAB and copy existing data.
     *
     * IMPORTANT: After a grow, the `buffer` property returns a NEW
     * SharedArrayBuffer.  The caller must re-send it to all worker threads.
     */
    private ensureCapacity(requiredSlots: number): void {
        if (requiredSlots <= this.slotCapacity) {
            return;
        }

        let newCapacity = this.slotCapacity;
        while (newCapacity < requiredSlots) {
            newCapacity = Math.ceil(newCapacity * GROWTH_FACTOR);
        }

        const newSab = new SharedArrayBuffer(newCapacity * this.embeddingDims * BYTES_PER_FLOAT);
        const newVectors = new Float32Array(newSab);

        // Copy existing data
        newVectors.set(this.vectors.subarray(0, this.cursor * this.embeddingDims));

        this.sab = newSab;
        this.vectors = newVectors;
        this.slotCapacity = newCapacity;
    }
}
