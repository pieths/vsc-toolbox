// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import { FileRef } from './fileRef';
import { AttrKey, CONTAINER_TYPES, SymbolType } from './parsers/types';
import type { IndexSymbol } from './parsers/types';
import { DocumentType } from './types';

/**
 * Wraps a hydrated `IndexSymbol[]` for a single file and provides
 * convenience query methods (container lookup, FQN resolution).
 *
 * Instances are produced by {@link CacheManager.getAllSymbols} and
 * surfaced to callers via {@link ContentIndex.getSymbols}.
 *
 * Note: this is a point-in-time snapshot. If the underlying source
 * file has been modified since the symbols were indexed, the symbol
 * positions and names may no longer match the file on disk.
 */
export class FileSymbols {
    /** The hydrated symbols for this file. */
    public readonly symbols: IndexSymbol[];

    /** The type of document this file represents. */
    public readonly docType: DocumentType;

    /**
     * For KnowledgeBase docs: 0-based inclusive line range of the
     * Overview body (excludes the heading line itself).
     */
    public readonly overviewRange?: { startLine: number; endLine: number };

    private readonly fileRef: FileRef;

    constructor(fileRef: FileRef, symbols: IndexSymbol[]) {
        this.fileRef = fileRef;
        this.symbols = symbols;

        // Detect knowledge base documents: a markdown file whose first
        // two symbols include an "Overview" heading (# or ##).
        const filePath = fileRef.getFilePath();
        if (filePath.endsWith('.md') && symbols.length > 0) {
            const overviewSymbol = symbols.slice(0, 2).find(s =>
                (s.type === SymbolType.MarkdownHeading1 ||
                    s.type === SymbolType.MarkdownHeading2) &&
                s.name === 'Overview'
            );
            if (overviewSymbol) {
                this.docType = DocumentType.KnowledgeBase;
                this.overviewRange = {
                    startLine: overviewSymbol.startLine + 1,
                    endLine: overviewSymbol.endLine
                };
            } else {
                this.docType = DocumentType.Standard;
            }
        } else {
            this.docType = DocumentType.Standard;
        }
    }

    /**
     * Get the absolute file path these symbols belong to.
     */
    getFilePath(): string {
        return this.fileRef.getFilePath();
    }

    /**
     * Get the innermost container (function, class, namespace, etc.)
     * that encloses a given line.
     *
     * @param line - 0-based line number
     * @returns The innermost containing IndexSymbol, or null if none found
     */
    getContainer(line: number): IndexSymbol | null {
        const containers = this.symbols.filter(s =>
            CONTAINER_TYPES.has(s.type) &&
            s.startLine <= line &&
            line <= s.endLine
        );
        return this.findInnermostSymbol(containers);
    }

    /**
     * Get the fully qualified name for a symbol at a given line.
     *
     * @param name - The symbol name to look up
     * @param line - 0-based line number
     * @returns The fully qualified name or the original name if not found
     */
    getFQN(name: string, line: number): string {
        const matches = this.symbols.filter(s =>
            s.name === name &&
            s.startLine <= line &&
            line <= s.endLine
        );
        const best = this.findInnermostSymbol(matches);
        if (!best) {
            return name;
        }
        return best.attrs.get(AttrKey.FullyQualifiedName) ?? best.name;
    }

    /**
     * From a list of candidate symbols, return the one with the
     * tightest enclosing range (smallest line span, then latest
     * start line as tiebreaker). Returns null if the list is empty.
     */
    private findInnermostSymbol(candidates: IndexSymbol[]): IndexSymbol | null {
        if (candidates.length === 0) {
            return null;
        }
        let best = candidates[0];
        for (let i = 1; i < candidates.length; i++) {
            const s = candidates[i];
            const bestSpan = best.endLine - best.startLine;
            const candidateSpan = s.endLine - s.startLine;
            if (candidateSpan < bestSpan ||
                (candidateSpan === bestSpan && s.startLine > best.startLine)) {
                best = s;
            }
        }
        return best;
    }
}
