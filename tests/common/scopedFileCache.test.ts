// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Tests for {@link ScopedFileCache}.
 *
 * Run with:
 * npx tsc -p tsconfig.test.json; node --test out-test/tests/common/scopedFileCache.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ScopedFileCache } from '../../src/common/scopedFileCache';

// ── Test fixtures ───────────────────────────────────────────────────────────

let tmpDir: string;
let fileA: string;
let fileB: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scopedFileCache-test-'));
    fileA = path.join(tmpDir, 'a.txt');
    fileB = path.join(tmpDir, 'b.txt');
    fs.writeFileSync(fileA, 'line1\nline2\nline3', 'utf8');
    fs.writeFileSync(fileB, 'alpha\nbeta', 'utf8');
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ScopedFileCache', () => {

    // ── Basic functionality ─────────────────────────────────────────────

    describe('basic file reading', () => {
        it('returns correct lines for a file', async () => {
            const cache = new ScopedFileCache();
            const lines = await cache.getLines(fileA);
            assert.deepStrictEqual(lines, ['line1', 'line2', 'line3']);
        });

        it('returns correct lines for a different file', async () => {
            const cache = new ScopedFileCache();
            const lines = await cache.getLines(fileB);
            assert.deepStrictEqual(lines, ['alpha', 'beta']);
        });

        it('handles empty file', async () => {
            const emptyFile = path.join(tmpDir, 'empty.txt');
            fs.writeFileSync(emptyFile, '', 'utf8');
            const cache = new ScopedFileCache();
            const lines = await cache.getLines(emptyFile);
            assert.deepStrictEqual(lines, ['']);
        });

        it('handles file with trailing newline', async () => {
            const file = path.join(tmpDir, 'trailing.txt');
            fs.writeFileSync(file, 'line1\nline2\n', 'utf8');
            const cache = new ScopedFileCache();
            const lines = await cache.getLines(file);
            assert.deepStrictEqual(lines, ['line1', 'line2', '']);
        });

        it('handles file with Windows line endings', async () => {
            const file = path.join(tmpDir, 'crlf.txt');
            fs.writeFileSync(file, 'line1\r\nline2\r\nline3', 'utf8');
            const cache = new ScopedFileCache();
            const lines = await cache.getLines(file);
            // split('\n') leaves \r on line ends
            assert.deepStrictEqual(lines, ['line1\r', 'line2\r', 'line3']);
        });
    });

    // ── Caching behavior ────────────────────────────────────────────────

    describe('caching', () => {
        it('second call returns the same array reference', async () => {
            const cache = new ScopedFileCache();
            const first = await cache.getLines(fileA);
            const second = await cache.getLines(fileA);
            assert.strictEqual(first, second, 'Expected same array reference');
        });

        it('different files return different arrays', async () => {
            const cache = new ScopedFileCache();
            const a = await cache.getLines(fileA);
            const b = await cache.getLines(fileB);
            assert.notStrictEqual(a, b);
            assert.deepStrictEqual(a, ['line1', 'line2', 'line3']);
            assert.deepStrictEqual(b, ['alpha', 'beta']);
        });

        it('returns cached (stale) data after file is modified on disk', async () => {
            const cache = new ScopedFileCache();
            const first = await cache.getLines(fileA);
            assert.deepStrictEqual(first, ['line1', 'line2', 'line3']);

            // Modify file on disk
            fs.writeFileSync(fileA, 'modified\ncontent', 'utf8');

            const second = await cache.getLines(fileA);
            // Should still return the original cached content
            assert.deepStrictEqual(second, ['line1', 'line2', 'line3']);
            assert.strictEqual(first, second);
        });
    });

    // ── clear() ─────────────────────────────────────────────────────────

    describe('clear', () => {
        it('causes next getLines to re-read from disk', async () => {
            const cache = new ScopedFileCache();
            const first = await cache.getLines(fileA);
            assert.deepStrictEqual(first, ['line1', 'line2', 'line3']);

            // Modify file and clear cache
            fs.writeFileSync(fileA, 'new1\nnew2', 'utf8');
            cache.clear();

            const second = await cache.getLines(fileA);
            assert.deepStrictEqual(second, ['new1', 'new2']);
            assert.notStrictEqual(first, second);
        });

        it('does not affect already-resolved references', async () => {
            const cache = new ScopedFileCache();
            const first = await cache.getLines(fileA);

            cache.clear();

            // The array we already hold should still be intact
            assert.deepStrictEqual(first, ['line1', 'line2', 'line3']);
        });

        it('clear while a Promise is being awaited does not break the awaiter', async () => {
            const cache = new ScopedFileCache();

            // Start the read but don't await yet
            const promise = cache.getLines(fileA);

            // Clear the cache while the read is in-flight
            cache.clear();

            // The promise should still resolve normally
            const lines = await promise;
            assert.deepStrictEqual(lines, ['line1', 'line2', 'line3']);
        });

        it('getLines after clear-during-inflight re-reads from disk', async () => {
            const cache = new ScopedFileCache();

            // Start first read
            const promise1 = cache.getLines(fileA);

            // Clear while in-flight
            cache.clear();

            // Modify file
            fs.writeFileSync(fileA, 'updated\ndata', 'utf8');

            // New call should re-read since cache was cleared
            const promise2 = cache.getLines(fileA);

            const [result1, result2] = await Promise.all([promise1, promise2]);

            // Both promises may see either original or updated content
            // depending on whether the OS completed the first read before
            // the writeFileSync. The key guarantee is that promise2 gets
            // its own read (not the cleared one) and both resolve without error.
            assert.ok(Array.isArray(result1), 'promise1 should resolve to an array');
            assert.ok(Array.isArray(result2), 'promise2 should resolve to an array');
            // promise2 should see the updated file since it was created after the write
            assert.deepStrictEqual(result2, ['updated', 'data']);
        });
    });

    // ── Error handling ──────────────────────────────────────────────────

    describe('error handling', () => {
        it('rejects for nonexistent file', async () => {
            const cache = new ScopedFileCache();
            await assert.rejects(
                () => cache.getLines(path.join(tmpDir, 'nonexistent.txt')),
                { code: 'ENOENT' },
            );
        });

        it('after a failed read, a subsequent call retries', async () => {
            const cache = new ScopedFileCache();
            const missingPath = path.join(tmpDir, 'missing.txt');

            // First call fails
            await assert.rejects(
                () => cache.getLines(missingPath),
                { code: 'ENOENT' },
            );

            // Create the file
            fs.writeFileSync(missingPath, 'now exists\nline2', 'utf8');

            // Second call should succeed (not return cached error)
            const lines = await cache.getLines(missingPath);
            assert.deepStrictEqual(lines, ['now exists', 'line2']);
        });
    });

    // ── Concurrency ─────────────────────────────────────────────────────

    describe('concurrency', () => {
        it('concurrent calls for the same file return the same array reference', async () => {
            const cache = new ScopedFileCache();

            // Launch both without awaiting — both execute their sync
            // portion before any async completion fires
            const p1 = cache.getLines(fileA);
            const p2 = cache.getLines(fileA);

            const [r1, r2] = await Promise.all([p1, p2]);

            assert.strictEqual(r1, r2, 'Expected same array reference from concurrent calls');
            assert.deepStrictEqual(r1, ['line1', 'line2', 'line3']);
        });

        it('many concurrent calls for the same file all get the same reference', async () => {
            const cache = new ScopedFileCache();

            const promises = Array.from({ length: 20 }, () => cache.getLines(fileA));
            const results = await Promise.all(promises);

            // All 20 should be the exact same array object
            for (let i = 1; i < results.length; i++) {
                assert.strictEqual(results[i], results[0],
                    `Result ${i} should be same reference as result 0`);
            }
            assert.deepStrictEqual(results[0], ['line1', 'line2', 'line3']);
        });

        it('concurrent calls result in only one fs.readFile call', async () => {
            const original = fs.promises.readFile;
            let readCount = 0;
            fs.promises.readFile = ((...args: Parameters<typeof original>) => {
                readCount++;
                return original.apply(fs.promises, args);
            }) as typeof original;

            try {
                const cache = new ScopedFileCache();
                const promises = Array.from({ length: 10 }, () => cache.getLines(fileA));
                await Promise.all(promises);

                assert.strictEqual(readCount, 1,
                    `Expected 1 fs.readFile call but got ${readCount}`);
            } finally {
                fs.promises.readFile = original;
            }
        });

        it('concurrent calls for different files return different arrays', async () => {
            const cache = new ScopedFileCache();

            const p1 = cache.getLines(fileA);
            const p2 = cache.getLines(fileB);

            const [r1, r2] = await Promise.all([p1, p2]);

            assert.notStrictEqual(r1, r2);
            assert.deepStrictEqual(r1, ['line1', 'line2', 'line3']);
            assert.deepStrictEqual(r2, ['alpha', 'beta']);
        });

        it('concurrent calls for a nonexistent file all reject', async () => {
            const cache = new ScopedFileCache();
            const missingPath = path.join(tmpDir, 'missing.txt');

            const p1 = cache.getLines(missingPath);
            const p2 = cache.getLines(missingPath);

            await assert.rejects(() => p1, { code: 'ENOENT' });
            await assert.rejects(() => p2, { code: 'ENOENT' });
        });
    });
});
