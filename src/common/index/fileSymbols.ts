// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import { AttrKey, CONTAINER_TYPES, SymbolType } from './parsers/types';
import type { IndexSymbol } from './parsers/types';
import { DocumentType } from './types';

/**
 * Wraps a hydrated `IndexSymbol[]` for a single file and provides
 * convenience query methods (container lookup, FQN resolution).
 *
 * Instances are produced by {@link ContentIndex.getSymbols} from
 * raw `IndexSymbol[]` arrays returned by CacheManager.
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

    private readonly filePath: string;

    constructor(filePath: string, symbols: IndexSymbol[]) {
        this.filePath = filePath;
        this.symbols = symbols;

        // Detect knowledge base documents: a markdown file whose first
        // two symbols include an "Overview" heading (# or ##).
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
        return this.filePath;
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
     * Get the line range around a given line that is free of other
     * symbols. The range is initially bounded by the innermost enclosing
     * symbol of the specified types (or the full file if none encloses the
     * line) and then further narrowed so it does not cross into any other
     * of the specified symbols.
     *
     * Example 1: a line inside a method (lines 10-30) with no nested
     * symbols returns { minLine: 10, maxLine: 30 } — the method's
     * full extent (assuming that delimiterTypes contains only namespace
     * and method symbol types).
     *
     * Example 2: a namespace (lines 1-20) containing a variable on
     * line 5 and a method (lines 8-18), calling this for line 5 returns
     * { minLine: 1, maxLine: 7 } — bounded by the namespace and narrowed
     * to stop before the method (assuming that delimiterTypes contains
     * only namespace and method symbol types).
     *
     * @param line - 0-based line number
     * @param fileLineCount - Total number of lines in the file
     * @param delimiterTypes - Symbol types that act as delimiters.
     *   Defaults to CONTAINER_TYPES if null or not specified.
     * @returns Object with minLine and maxLine (0-based inclusive)
     */
    getBoundsDelimitedBySymbols(
        line: number,
        fileLineCount: number,
        delimiterTypes: ReadonlySet<SymbolType> | null = null
    ): { minLine: number; maxLine: number } {
        const symbolTypes = delimiterTypes ?? CONTAINER_TYPES;

        // Find the innermost symbol of the specified types that
        // encloses the line. This sets the initial enclosing bounds.
        // If no such symbol exists, the full file is used as the
        // initial enclosing bounds.
        const enclosing = this.findInnermostSymbol(
            this.symbols.filter(s =>
                symbolTypes.has(s.type) &&
                s.startLine <= line &&
                line <= s.endLine
            )
        );
        let minLine = enclosing?.startLine ?? 0;
        let maxLine = enclosing?.endLine ?? (fileLineCount - 1);

        // Now narrow the bounds by looking at all other symbols
        // of the specified types. Any symbol that is within the
        // initial enclosing bounds but does not contain the line
        // acts as a wall. Context should not extend into it.
        // All remaining symbols that are not the initial enclosing
        // symbol, must either be enclosing (but with wider bounds)
        // or non-enclosing (strictly before or after the line).
        for (const sym of this.symbols) {
            if (!symbolTypes.has(sym.type)) {
                continue;
            }

            // Skip symbols that contain the match line. These are
            // either larger enclosing symbols or the match's own
            // container.
            if (sym.startLine <= line && line <= sym.endLine) {
                continue;
            }

            // At this point the symbol does not contain the match
            // line, so it is strictly before or after it. Skip any
            // that start outside the initial enclosing bounds.
            if (sym.startLine < minLine || sym.startLine > maxLine) {
                continue;
            }

            // Symbol is before the match line — raise the floor
            if (sym.endLine < line && sym.endLine >= minLine) {
                minLine = Math.max(minLine, sym.endLine + 1);
            }

            // Symbol is after the match line — lower the ceiling
            if (sym.startLine > line && sym.startLine <= maxLine) {
                maxLine = Math.min(maxLine, sym.startLine - 1);
            }
        }

        return { minLine, maxLine };
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
