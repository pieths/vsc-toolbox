// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * A read-only view over source file lines that ensures no virtual line
 * exceeds a maximum character width. Lines that are within the limit
 * are passed through as-is; longer lines are split on space boundaries
 * (or character boundaries if no suitable space is found).
 *
 * Split segments include any trailing space from the split point in
 * the segment text, so that concatenating consecutive segments from
 * the same source line reconstructs the original content exactly.
 *
 * This normalizes the line structure so that downstream chunking logic
 * can operate purely on line boundaries without special-casing long lines.
 */

export class SplitLineView {
    /** Total number of virtual lines. */
    readonly lineCount: number;

    /**
     * Virtual line texts. When no lines were split, this is the original
     * source array reference (zero-copy). Otherwise, it contains a mix
     * of original line references and split segments.
     */
    private readonly lines: readonly string[];

    /**
     * Maps each virtual line index to its source line number.
     * When no lines were split, this is null and the mapping is identity.
     */
    private readonly virtualToSourceIndices: number[] | null;

    /**
     * Maps each source line index to the first virtual line index for
     * that source line. Only allocated when lines were split; null otherwise.
     */
    private readonly sourceToVirtualIndices: number[] | null;

    /**
     * Create a SplitLineView over source lines.
     *
     * @param lines - The original source file lines
     * @param maxLineChars - Maximum character width per virtual line.
     *     Lines exceeding this are split on space boundaries.
     */
    constructor(lines: readonly string[], maxLineChars: number) {
        // Fast path: check if any line needs splitting
        let needsSplitting = false;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].length > maxLineChars) {
                needsSplitting = true;
                break;
            }
        }

        if (!needsSplitting) {
            // No lines exceed the limit — zero-copy pass-through
            this.lines = lines;
            this.virtualToSourceIndices = null;
            this.sourceToVirtualIndices = null;
            this.lineCount = lines.length;
            return;
        }

        // Build virtual lines by splitting long lines
        const virtualLines: string[] = [];
        const virtualToSourceIndices: number[] = [];
        this.sourceToVirtualIndices = new Array(lines.length);

        for (let srcIdx = 0; srcIdx < lines.length; srcIdx++) {
            const line = lines[srcIdx];
            this.sourceToVirtualIndices[srcIdx] = virtualLines.length;

            if (line.length <= maxLineChars) {
                virtualLines.push(line);
                virtualToSourceIndices.push(srcIdx);
                continue;
            }

            // Split the long line into segments.
            // Space-split: include the space in the first segment as a
            // trailing character so that direct concatenation of segments
            // reconstructs the original line.
            let remaining = line;
            while (remaining.length > 0) {
                if (remaining.length <= maxLineChars) {
                    virtualLines.push(remaining);
                    virtualToSourceIndices.push(srcIdx);
                    break;
                }

                // Find a space boundary to split on. Search from
                // maxLineChars - 1 so that including the trailing space
                // keeps the segment within maxLineChars.
                let splitAt = remaining.lastIndexOf(' ', maxLineChars - 1);
                const splitOnSpace = splitAt > 0 && splitAt >= maxLineChars * 0.8;
                if (!splitOnSpace) {
                    // No good space boundary — split on character boundary
                    splitAt = maxLineChars;
                }

                // Include the space in this segment (splitAt + 1) so that
                // concatenation of segments preserves the original text.
                const segEnd = splitOnSpace ? splitAt + 1 : splitAt;
                virtualLines.push(remaining.substring(0, segEnd));
                virtualToSourceIndices.push(srcIdx);

                remaining = remaining.substring(segEnd);
            }
        }

        this.lines = virtualLines;
        this.virtualToSourceIndices = virtualToSourceIndices;
        this.lineCount = virtualLines.length;
    }

    /**
     * Get the text of a single virtual line.
     */
    getLine(index: number): string {
        return this.lines[index];
    }

    /**
     * Get the character length of a virtual line.
     */
    getLineLength(index: number): number {
        return this.lines[index].length;
    }

    /**
     * Join virtual lines [start, end) using the correct separator:
     * '\n' between lines from different source lines, direct
     * concatenation between segments from the same source line.
     *
     * @param start - 0-based inclusive start index
     * @param end - 0-based exclusive end index
     */
    getText(start: number, end: number): string {
        if (start >= end) return '';
        if (end - start === 1) return this.lines[start];

        if (this.virtualToSourceIndices === null) {
            // Fast path: no splits, all newlines — native join is faster
            return this.lines.slice(start, end).join('\n');
        }

        let result = this.lines[start];
        for (let i = start + 1; i < end; i++) {
            if (this.virtualToSourceIndices[i] !== this.virtualToSourceIndices[i - 1]) {
                result += '\n';
            }
            result += this.lines[i];
        }

        return result;
    }

    /**
     * Map a virtual line range back to source line numbers.
     *
     * @param vStart - 0-based inclusive virtual start line
     * @param vEnd - 0-based exclusive virtual end line
     * @returns [sourceStart, sourceEnd) — 0-based, exclusive end
     */
    getSourceRange(vStart: number, vEnd: number): [number, number] {
        if (this.virtualToSourceIndices === null) {
            // Identity mapping — virtual lines are source lines
            return [vStart, vEnd];
        }
        const sourceStart = this.virtualToSourceIndices[vStart];
        const sourceEnd = this.virtualToSourceIndices[vEnd - 1] + 1;
        return [sourceStart, sourceEnd];
    }

    /**
     * Map a source line range to the corresponding virtual line range.
     *
     * @param sourceStart - 0-based inclusive source start line
     * @param sourceEnd - 0-based exclusive source end line
     * @returns [vStart, vEnd) — 0-based, exclusive end
     */
    getVirtualRange(sourceStart: number, sourceEnd: number): [number, number] {
        if (this.sourceToVirtualIndices === null) {
            // Identity mapping — virtual lines are source lines
            return [sourceStart, sourceEnd];
        }
        const vStart = this.sourceToVirtualIndices[sourceStart];
        const vEnd = sourceEnd < this.sourceToVirtualIndices.length
            ? this.sourceToVirtualIndices[sourceEnd]
            : this.lineCount;
        return [vStart, vEnd];
    }
}
