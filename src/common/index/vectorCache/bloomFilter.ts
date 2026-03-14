// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Bloom filter — a space-efficient probabilistic data structure.
 *
 * Answers "is this element in the set?" with two possible responses:
 *   - "Definitely no" — guaranteed correct, zero false negatives.
 *   - "Probably yes"  — might be wrong (false positive), but
 *     configurable to be extremely rare.
 *
 * Uses the Kirsch-Mitzenmacker optimization: only two base hash
 * functions are needed.  Since input keys are already SHA-256 hex
 * strings (uniformly distributed cryptographic hashes), the two base
 * hashes are extracted directly from the string — no additional
 * hashing is needed.
 *
 * Backed by a Uint32Array (efficient, no GC pressure).
 */

/**
 * Compute the optimal number of bits for a bloom filter.
 *
 *   m = -(n * ln(p)) / (ln(2))^2
 */
function optimalBits(expectedEntries: number, falsePositiveRate: number): number {
    const m = -(expectedEntries * Math.log(falsePositiveRate)) / (Math.LN2 * Math.LN2);
    return Math.ceil(m);
}

/**
 * Compute the optimal number of hash functions for a bloom filter.
 *
 *   k = (m / n) * ln(2)
 */
function optimalK(numBits: number, expectedEntries: number): number {
    const k = (numBits / expectedEntries) * Math.LN2;
    return Math.max(1, Math.round(k));
}

export class BloomFilter {
    private readonly bits: Uint32Array;
    private readonly numBits: number;
    private readonly k: number;

    /**
     * Create a new bloom filter.
     *
     * @param expectedEntries — expected number of entries.
     * @param falsePositiveRate — desired false positive rate (e.g. 0.001 for 0.1%).
     */
    constructor(expectedEntries: number, falsePositiveRate: number = 0.001) {
        this.numBits = optimalBits(expectedEntries, falsePositiveRate);
        this.k = optimalK(this.numBits, expectedEntries);
        // Uint32Array: each element holds 32 bits
        this.bits = new Uint32Array(Math.ceil(this.numBits / 32));
    }

    /**
     * Add a SHA-256 hex string to the filter.
     *
     * Hash derivation: each hex character is 4 bits, so 8 hex chars =
     * 32 bits — the full range of a 32-bit unsigned integer.  Two
     * non-overlapping 32-bit values (h1, h2) are extracted from the
     * first 16 hex characters of the SHA-256 string.  Since SHA-256
     * output is cryptographically uniform, these are independent and
     * uniformly distributed — no additional hashing is needed.
     *
     * 32-bit hashes are sufficient as long as numBits < 2^32 (~512 MB
     * bloom filter).  At 20M entries with 0.01% FPR, numBits ≈ 383M
     * which is well within range.
     */
    add(sha256: string): void {
        const h1 = parseInt(sha256.substring(0, 8), 16);
        const h2 = parseInt(sha256.substring(8, 16), 16);

        for (let i = 0; i < this.k; i++) {
            const pos = Math.abs((h1 + i * h2) % this.numBits);
            const wordIndex = pos >>> 5;        // pos / 32
            const bitIndex = pos & 0x1f;        // pos % 32
            this.bits[wordIndex] |= (1 << bitIndex);
        }
    }

    /**
     * Check whether a SHA-256 hex string might be in the filter.
     *
     * @returns `true` if the element is probably in the set (may be a
     *          false positive).  `false` if the element is definitely
     *          NOT in the set (guaranteed correct).
     */
    mightContain(sha256: string): boolean {
        const h1 = parseInt(sha256.substring(0, 8), 16);
        const h2 = parseInt(sha256.substring(8, 16), 16);

        for (let i = 0; i < this.k; i++) {
            const pos = Math.abs((h1 + i * h2) % this.numBits);
            const wordIndex = pos >>> 5;
            const bitIndex = pos & 0x1f;
            if ((this.bits[wordIndex] & (1 << bitIndex)) === 0) {
                return false;
            }
        }
        return true;
    }

    /**
     * Reset the filter to empty.
     */
    clear(): void {
        this.bits.fill(0);
    }
}
