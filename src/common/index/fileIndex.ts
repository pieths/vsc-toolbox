// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { FunctionDetails, ContainerDetails } from './types';

/**
 * Represents a single tag entry from a ctags JSON output file.
 * Only includes fields we care about - path and pattern are ignored
 * since we already know the file path and have line numbers.
 */
interface Tag {
    name: string;
    line: number;
    column?: number;
    end?: number;
    kind: string;
    scope?: string;
    scopeKind?: string;
    signature?: string;
    typeref?: string;
}

/**
 * Cached tags entry with mtime for staleness detection.
 */
interface CachedTags {
    tags: Tag[];
    mtime: number;  // mtime of tags file when parsed
}

/**
 * Simple LRU cache for parsed tags arrays.
 * Keys are tags file paths, values are parsed Tag arrays with their mtime.
 */
class TagsCache {
    private cache = new Map<string, CachedTags>();
    private maxSize: number;

    constructor(maxSize: number = 100) {
        this.maxSize = maxSize;
    }

    /**
     * Get cached tags if the mtime matches.
     * Returns undefined if not cached or mtime doesn't match.
     */
    get(key: string, currentMtime: number): Tag[] | undefined {
        const entry = this.cache.get(key);
        if (entry !== undefined) {
            if (entry.mtime === currentMtime) {
                // Move to end (most recently used)
                this.cache.delete(key);
                this.cache.set(key, entry);
                return entry.tags;
            } else {
                // Stale entry - remove it
                this.cache.delete(key);
            }
        }
        return undefined;
    }

    set(key: string, tags: Tag[], mtime: number): void {
        this.cache.delete(key);

        if (this.cache.size >= this.maxSize) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey !== undefined) {
                this.cache.delete(oldestKey);
            }
        }

        this.cache.set(key, { tags, mtime });
    }

    delete(key: string): void {
        this.cache.delete(key);
    }

    clear(): void {
        this.cache.clear();
    }
}

// Module-level LRU cache shared by all FileIndex instances
const tagsCache = new TagsCache(300);

// Regex for replacing anonymous namespace markers (compiled once)
const ANON_NAMESPACE_REGEX = /__anon[a-fA-F0-9]+/g;

/**
 * Replace anonymous namespace markers (e.g., __anon1234abcd) with "(anonymous namespace)".
 * ctags uses these markers for unnamed namespaces in C++.
 */
function normalizeScope(scope: string): string {
    return scope.replace(ANON_NAMESPACE_REGEX, '(anonymous namespace)');
}

/**
 * Convert a ctags kind to the equivalent vscode.SymbolKind.
 * @param ctagsKind - The ctags kind string (e.g., "function", "class")
 * @returns The vscode.SymbolKind value, or undefined if no mapping exists
 */
function ctagsKindToSymbolKind(ctagsKind: string): vscode.SymbolKind | undefined {
    switch (ctagsKind) {
        case 'function':
            return vscode.SymbolKind.Function;
        case 'method':
            return vscode.SymbolKind.Method;
        case 'class':
            return vscode.SymbolKind.Class;
        case 'struct':
            return vscode.SymbolKind.Struct;
        case 'enum':
            return vscode.SymbolKind.Enum;
        case 'enumerator':
            return vscode.SymbolKind.EnumMember;
        case 'namespace':
            return vscode.SymbolKind.Namespace;
        case 'module':
            return vscode.SymbolKind.Module;
        case 'interface':
            return vscode.SymbolKind.Interface;
        case 'property':
            return vscode.SymbolKind.Property;
        case 'field':
        case 'member':
            return vscode.SymbolKind.Field;
        case 'variable':
            return vscode.SymbolKind.Variable;
        case 'constant':
            return vscode.SymbolKind.Constant;
        case 'typedef':
        case 'alias':
            return vscode.SymbolKind.TypeParameter;
        case 'constructor':
            return vscode.SymbolKind.Constructor;
        case 'package':
            return vscode.SymbolKind.Package;
        case 'macro':
            return vscode.SymbolKind.Constant;  // No direct mapping
        case 'prototype':
            return vscode.SymbolKind.Function;  // Forward declaration
        default:
            return undefined;
    }
}

/**
 * FileIndex manages metadata for a single file in the index.
 * It stores the file path and the path to its ctags file.
 * Validity is determined by comparing filesystem mtimes.
 */
export class FileIndex {
    private filePath: string;
    private tagsPath: string;

    constructor(filePath: string, cacheDir: string) {
        this.filePath = filePath;
        this.tagsPath = this.computeTagsPath(cacheDir);
    }

    /**
     * Compute the deterministic tags file path for this source file.
     * Uses MD5 hash of the full path to avoid conflicts.
     */
    private computeTagsPath(cacheDir: string): string {
        const hash = crypto.createHash('md5')
            .update(this.filePath)
            .digest('hex')
            .substring(0, 16)
            .toUpperCase();
        const fileName = path.basename(this.filePath);
        return path.join(cacheDir, `${fileName}.${hash}.tags`);
    }

    /**
     * Get the file path.
     */
    getFilePath(): string {
        return this.filePath;
    }

    /**
     * Get the path to the tags file.
     * Always returns the computed path - use isValid() to check if it exists.
     */
    getTagsPath(): string {
        return this.tagsPath;
    }

    /**
     * Check if the tags file exists and is newer than the source file.
     * Uses synchronous stat calls for simplicity - stat is fast (~0.05ms).
     */
    isValid(): boolean {
        try {
            const sourceMtime = fs.statSync(this.filePath).mtimeMs;
            const tagsMtime = fs.statSync(this.tagsPath).mtimeMs;
            return tagsMtime >= sourceMtime;
        } catch {
            return false;  // Tags file doesn't exist or other error
        }
    }

    /**
     * Clear cached tags for this file.
     * File deletion is fire-and-forget since worker overwrites anyway.
     */
    invalidate(): void {
        tagsCache.delete(this.tagsPath);
        fs.promises.unlink(this.tagsPath).catch(() => { });
    }

    /**
     * Load and parse tags from the tags file.
     * Checks mtime before returning to ensure freshness.
     * @returns Array of Tag objects, or null if not valid or parsing fails
     */
    private async getTags(): Promise<Tag[] | null> {
        // Get mtimes - also serves as existence/validity check
        let sourceMtime: number;
        let tagsMtime: number;
        try {
            sourceMtime = fs.statSync(this.filePath).mtimeMs;
            tagsMtime = fs.statSync(this.tagsPath).mtimeMs;
            if (tagsMtime < sourceMtime) {
                return null;  // Tags file is stale
            }
        } catch {
            return null;  // File doesn't exist or other error
        }

        // Check LRU cache - pass tagsMtime for staleness check
        const cached = tagsCache.get(this.tagsPath, tagsMtime);
        if (cached !== undefined) {
            return cached;
        }

        // Read and parse the tags file
        try {
            const content = await fs.promises.readFile(this.tagsPath, 'utf8');
            const tags: Tag[] = [];

            for (const line of content.split('\n')) {
                if (!line.trim()) continue;

                // Skip pseudo-tags (metadata) - fast string check before JSON.parse
                if (line.startsWith('{"_type": "ptag"')) continue;

                const entry = JSON.parse(line);

                // Safety fallback for any non-tag entries
                if (entry._type !== 'tag') continue;

                tags.push({
                    name: entry.name,
                    line: entry.line,
                    column: entry.column,
                    end: entry.end,
                    kind: entry.kind,
                    scope: entry.scope,
                    scopeKind: entry.scopeKind,
                    signature: entry.signature,
                    typeref: entry.typeref
                });
            }

            // Cache with the original mtime to avoid marking the
            // cached entry as newer than it could be. It is possible
            // that we are returning slightly stale data if the file changed
            // again after the mtime check above, but that's acceptable.
            // The tagsCache will store the older mtime and re-validate
            // on next get().
            tagsCache.set(this.tagsPath, tags, tagsMtime);
            return tags;
        } catch {
            return null;
        }
    }

    /**
     * Get the fully qualified name for a symbol at a given location.
     * Only works for code files (not markdown, etc.).
     * @param name - The symbol name to look up
     * @param location - The location of the symbol in the source file
     * @returns The fully qualified name (e.g., "namespace::Class::method") or the original name if not found
     */
    async getFullyQualifiedName(name: string, location: vscode.Location): Promise<string> {
        const tags = await this.getTags();
        if (tags === null) {
            return name;  // Unable to get tags - return simple name
        }

        // Convert from 0-based VS Code line to 1-based ctags line
        const line = location.range.start.line + 1;

        // Find a tag matching the name and line
        const tag = tags.find(t => t.name === name && t.line === line);
        if (!tag) {
            return name;  // Tag not found - return simple name
        }

        if (tag.scope) {
            const scope = normalizeScope(tag.scope);
            return `${scope}::${tag.name}`;
        }
        return tag.name;
    }

    /**
     * Get detailed information about a function at a given line.
     * @param name - The function name to look up
     * @param line - The 1-based line number where the function is defined
     * @returns FunctionDetails object, or null if not found or not a function/method
     */
    async getFunctionDetails(name: string, line: number): Promise<FunctionDetails | null> {
        const tags = await this.getTags();
        if (tags === null) {
            return null;  // Unable to get tags
        }

        // Find a tag matching the name and line
        const tag = tags.find(t => t.name === name && t.line === line);
        if (!tag) {
            return null;  // Tag not found
        }

        // Verify it's a function or method (not a variable, class, etc.)
        // ctags kinds: "function", "method", "prototype" (declaration)
        if (tag.kind !== 'function' && tag.kind !== 'method' && tag.kind !== 'prototype') {
            return null;  // Not a function, method, or prototype
        }

        // Build the fully qualified name
        let fullyQualifiedName = tag.name;
        let scope = tag.scope;
        if (scope) {
            scope = normalizeScope(scope);
            fullyQualifiedName = `${scope}::${tag.name}`;
        }

        // Build the signature: "returnType name(params)"
        // typeref is typically "typename:ReturnType" or similar
        let returnType = '';
        if (tag.typeref) {
            // Extract the type after the colon (e.g., "typename:int" -> "int")
            const colonIndex = tag.typeref.indexOf(':');
            if (colonIndex !== -1) {
                returnType = tag.typeref.substring(colonIndex + 1);
            } else {
                returnType = tag.typeref;
            }
        }

        // Combine return type, name, and signature (params)
        const params = tag.signature || '';
        const signature = returnType
            ? `${returnType} ${tag.name}${params}`
            : `${tag.name}${params}`;

        return {
            fullyQualifiedName,
            scope,
            signature,
            startLine: tag.line,
            startColumn: tag.column,
            endLine: tag.end ?? tag.line
        };
    }

    /**
     * Get the innermost container (function, class, namespace, etc.) that contains a given line.
     * @param line - The 1-based line number to find the container for
     * @returns ContainerDetails object, or null if no container found
     */
    async getContainer(line: number): Promise<ContainerDetails | null> {
        const tags = await this.getTags();
        if (tags === null) {
            return null;  // Unable to get tags
        }

        // Find all tags that contain the given line (have both start and end)
        // A tag contains the line if: tag.line <= line <= tag.end
        const containingTags = tags.filter(t =>
            t.end !== undefined && t.line <= line && line <= t.end
        );

        if (containingTags.length === 0) {
            return null;  // No container found
        }

        // Find the innermost container (smallest range)
        // This is the one with the largest start line that still contains the target
        let innermost = containingTags[0];
        for (const tag of containingTags) {
            // Prefer the tag with the smallest range (end - line)
            // If ranges are equal, prefer the one that starts later
            const currentRange = innermost.end! - innermost.line;
            const candidateRange = tag.end! - tag.line;
            if (candidateRange < currentRange ||
                (candidateRange === currentRange && tag.line > innermost.line)) {
                innermost = tag;
            }
        }

        // Build the fully qualified name
        let fullyQualifiedName = innermost.name;
        if (innermost.scope) {
            const scope = normalizeScope(innermost.scope);
            fullyQualifiedName = `${scope}::${innermost.name}`;
        }

        return {
            name: innermost.name,
            fullyQualifiedName: fullyQualifiedName,
            type: ctagsKindToSymbolKind(innermost.kind),
            ctagsType: innermost.kind,
            startLine: innermost.line,
            startColumn: innermost.column,
            endLine: innermost.end!
        };
    }
}
