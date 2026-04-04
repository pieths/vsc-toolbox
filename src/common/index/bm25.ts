// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * BM25 scoring for ranked search results.
 *
 * Takes raw per-pattern match data from the native search
 * (OR semantics) and produces a relevance-ranked list of files.
 */

import type { SearchOutput } from './types';

/**
 * A scored file result with all matched line numbers merged.
 */
export interface ScoredFile {
    /** Absolute file path */
    filePath: string;
    /** BM25 relevance score (higher is more relevant) */
    score: number;
    /** Total number of lines in the file */
    totalLines: number;
    /** All matched line numbers (0-based, deduplicated, sorted) from all patterns */
    lineNumbers: number[];
}

/**
 * Rank search results using BM25 scoring with an optional
 * proximity bonus for lines where multiple patterns co-occur.
 *
 * @param results - Raw search outputs from worker threads (merged across all workers)
 * @param totalFilesSearched - Total number of files that were searched (for IDF)
 * @param k1 - BM25 term frequency saturation parameter (default: 1.2)
 * @param b - BM25 document length normalization parameter (default: 0.75)
 * @param proximityWeight - Weight for the co-occurrence proximity bonus (default: 0.5)
 * @returns Scored files sorted by score descending
 */
export function rankFiles(
    results: SearchOutput[],
    totalFilesSearched: number,
    k1: number = 1.2,
    b: number = 0.75,
    proximityWeight: number = 0.5,
): ScoredFile[] {
    if (results.length === 0) {
        return [];
    }

    const N = totalFilesSearched;

    // Compute document frequency (df) per pattern index:
    // how many files each pattern appeared in.
    const df = new Map<number, number>();
    for (const file of results) {
        for (const pm of file.patternMatches) {
            df.set(pm.patternIndex, (df.get(pm.patternIndex) ?? 0) + 1);
        }
    }

    // Compute IDF per pattern index.
    const idf = new Map<number, number>();
    for (const [patternIndex, docFreq] of df) {
        idf.set(patternIndex, Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1));
    }

    // Compute average document length across matched files.
    let totalLines = 0;
    for (const file of results) {
        totalLines += file.totalLines;
    }
    const avgdl = totalLines / results.length;

    // Score each file.
    const scored: ScoredFile[] = [];
    for (const file of results) {
        const dl = file.totalLines;

        // BM25 score: sum across all matched patterns.
        let bm25Score = 0;
        for (const pm of file.patternMatches) {
            const termIdf = idf.get(pm.patternIndex) ?? 0;
            const tf = pm.frequency;
            bm25Score += termIdf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl));
        }

        // Proximity bonus: lines where 2+ patterns co-occur.
        let proximityBonus = 0;
        if (file.patternMatches.length >= 2) {
            // Build line → pattern indices map.
            const lineToPatterns = new Map<number, number[]>();
            for (const pm of file.patternMatches) {
                for (const ln of pm.lineNumbers) {
                    let list = lineToPatterns.get(ln);
                    if (!list) {
                        list = [];
                        lineToPatterns.set(ln, list);
                    }
                    list.push(pm.patternIndex);
                }
            }

            // Sum IDF of co-occurring patterns on shared lines.
            for (const patterns of lineToPatterns.values()) {
                if (patterns.length >= 2) {
                    for (const pi of patterns) {
                        proximityBonus += idf.get(pi) ?? 0;
                    }
                }
            }
        }

        // Merge all line numbers across patterns (deduplicated, sorted).
        const allLines = new Set<number>();
        for (const pm of file.patternMatches) {
            for (const ln of pm.lineNumbers) {
                allLines.add(ln);
            }
        }
        const lineNumbers = Array.from(allLines).sort((a, b) => a - b);

        scored.push({
            filePath: file.filePath,
            score: bm25Score + proximityWeight * proximityBonus,
            totalLines: file.totalLines,
            lineNumbers,
        });
    }

    // Sort by score descending.
    scored.sort((a, b) => b.score - a.score);

    return scored;
}
