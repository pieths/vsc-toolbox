// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as fs from 'fs';

/**
 * Cache for file contents to avoid repeated file reads
 * during a single invocation of a tool or command.
 */
export class ScopedFileCache {
    private cache = new Map<string, Promise<string[]>>();

    async getLines(filePath: string): Promise<string[]> {
        if (!this.cache.has(filePath)) {
            this.cache.set(filePath, fs.promises.readFile(filePath, 'utf8')
                .then(content => content.split('\n'))
                .catch(err => { this.cache.delete(filePath); throw err; }));
        }
        return this.cache.get(filePath)!;
    }

    clear(): void {
        this.cache.clear();
    }
}
