// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as fs from 'fs';

/**
 * Cache for file contents to avoid repeated file reads
 * during a single invocation of a tool or command.
 */
export class ScopedFileCache {
    private cache = new Map<string, string[]>();

    async getLines(filePath: string): Promise<string[]> {
        if (!this.cache.has(filePath)) {
            const content = await fs.promises.readFile(filePath, 'utf8');
            this.cache.set(filePath, content.split('\n'));
        }
        return this.cache.get(filePath)!;
    }

    clear(): void {
        this.cache.clear();
    }
}
