// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Worker task: index a file using ctags.
 * Runs ctags to generate a JSON tags file for the input file.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { IndexStatus } from '../../types';
import type { IndexInput, IndexOutput } from '../../types';

const execFileAsync = promisify(execFile);

/**
 * Index a file using ctags.
 * Runs ctags to generate a JSON tags file for the input file.
 *
 * @param input - Index input containing file path, ctags path, and output tags path
 * @returns Index output with tags path or error
 */
export async function indexFile(input: IndexInput): Promise<IndexOutput> {
    try {
        const sourceMtime = fs.statSync(input.filePath).mtimeMs;
        const tagsMtime = fs.statSync(input.tagsPath).mtimeMs;
        if (tagsMtime >= sourceMtime) {
            // The tags file is up-to-date, skip indexing
            return {
                type: 'index',
                status: IndexStatus.Skipped,
                filePath: input.filePath,
                tagsPath: input.tagsPath,
            };
        }
    } catch {
        // Tags file doesn't exist or other error - proceed with indexing
    }

    try {
        // Read source file and compute SHA256 hash
        const sourceContent = fs.readFileSync(input.filePath);
        const hash = crypto.createHash('sha256').update(sourceContent).digest('hex');

        if (fs.existsSync(input.tagsPath)) {
            // Check the SHA256 hash at the end of the tags file to see if
            // it matches the current source content. The last line is exactly:
            // {"_type": "sha256", "hash": "<64 hex chars>"}\n  (95 bytes)
            const HASH_LINE_LEN = 96;
            const HASH_OFFSET = 29; // offset to the start of the 64-char hex hash
            const fileSize = fs.statSync(input.tagsPath).size;
            if (fileSize >= HASH_LINE_LEN) {
                const fd = fs.openSync(input.tagsPath, 'r');
                const buf = Buffer.alloc(HASH_LINE_LEN);
                fs.readSync(fd, buf, 0, HASH_LINE_LEN, fileSize - HASH_LINE_LEN);
                fs.closeSync(fd);
                const storedHash = buf.toString('utf8').substring(HASH_OFFSET, HASH_OFFSET + 64);
                if (storedHash === hash) {
                    return {
                        type: 'index',
                        status: IndexStatus.Skipped,
                        filePath: input.filePath,
                        tagsPath: input.tagsPath,
                    };
                }
            }

            // Delete existing tags file - ctags refuses to overwrite it.
            // JSON-format tags files because they don't look like traditional tags
            // TODO: remove this when using ctags version that supports force overwrites.
            try {
                fs.unlinkSync(input.tagsPath);
            } catch (err) {
                console.error(`Failed to delete ${input.tagsPath}:`, err);
            }
        }

        // Run ctags with JSON output format
        // --fields=+neZKS: line number, end line, scope with kind, kind full name, signature
        // --kinds-all='*': include all symbol kinds
        // --output-format=json: structured JSON output
        await execFileAsync(input.ctagsPath, [
            '--output-format=json',
            '--fields=+cneNZKS',
            '--kinds-all=*',
            '-o', input.tagsPath,
            input.filePath
        ], { timeout: 3000 });

        // Append hash line at the end of the tags file
        if (fs.existsSync(input.tagsPath)) {
            // If modifying this line format, also update the
            // HASH_LINE_LEN and HASH_OFFSET constants above
            // and update the same values in FileIndex.isValid().
            fs.appendFileSync(input.tagsPath, `{"_type": "sha256", "hash": "${hash}"}\n`);
        } else {
            return {
                type: 'index',
                status: IndexStatus.Failed,
                filePath: input.filePath,
                tagsPath: null,
                error: 'ctags did not produce an output file in the allotted time'
            };
        }

        return {
            type: 'index',
            status: IndexStatus.Indexed,
            filePath: input.filePath,
            tagsPath: input.tagsPath,
        };
    } catch (error) {
        return {
            type: 'index',
            status: IndexStatus.Failed,
            filePath: input.filePath,
            tagsPath: null,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
