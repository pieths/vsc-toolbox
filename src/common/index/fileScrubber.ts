// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import picomatch from 'picomatch';

/**
 * Map from picomatch glob (matched against absolute file paths)
 * to an array of regex pattern strings.
 */
export type FileScrubPatterns = Record<string, string[]>;

/**
 * Applies glob-scoped regex replacements to file contents.
 *
 * Given a map of picomatch globs to regex pattern arrays, the scrubber
 * tests each file path against the globs and runs the associated regex
 * patterns against the file's source text. Every match is replaced
 * with spaces of equal length, preserving the original byte offsets.
 */
export class FileScrubber {
    /** Cache: glob string → compiled picomatch matcher. */
    private readonly globMatcherCache = new Map<string, (testPath: string) => boolean>();

    /** Cache: glob string → compiled `RegExp` for that glob's patterns. */
    private readonly globRegexCache = new Map<string, RegExp>();

    private patterns: FileScrubPatterns;

    /**
     * @param patterns - Glob → regex-string[] map. Globs are
     *     tested against absolute file paths.
     */
    constructor(patterns: FileScrubPatterns) {
        this.patterns = patterns;
    }

    /**
     * Replace the configured `patterns` map, but only if its
     * content differs from what is already stored.
     *
     * @returns `true` when the internal state was updated, `false`
     *     when the new map matched the existing one.
     */
    updatePatterns(patterns: FileScrubPatterns): boolean {
        if (this.patternsEqual(this.patterns, patterns)) {
            return false;
        }
        // Clear caches since globs or patterns may have changed
        this.globMatcherCache.clear();
        this.globRegexCache.clear();
        this.patterns = patterns;
        return true;
    }

    /**
     * Validate a `patterns` map.
     *
     * Each glob key must compile under picomatch and each pattern value
     * must be a valid JavaScript regex (both standalone and when
     * wrapped/combined the way {@link scrubFile} will combine them).
     *
     * @returns `null` on success, or a human-readable error message on
     *     the first failure.
     */
    static validatePatterns(map: FileScrubPatterns | undefined): string | null {
        if (!map || typeof map !== 'object') {
            return null;
        }
        for (const [glob, patterns] of Object.entries(map)) {
            if (!Array.isArray(patterns)) {
                return `value for glob "${glob}" must be an array of regex strings`;
            }
            for (const p of patterns) {
                if (typeof p !== 'string') {
                    return `pattern in glob "${glob}" is not a string: ${JSON.stringify(p)}`;
                }
                try {
                    new RegExp(p, 'g');
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    return `invalid regex in glob "${glob}": "${p}" — ${msg}`;
                }
            }
            if (patterns.length > 0) {
                try {
                    new RegExp(patterns.map(p => `(?:${p})`).join('|'), 'g');
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    return `patterns under glob "${glob}" cannot be combined: ${msg}`;
                }
            }
            try {
                picomatch(glob, { windows: true });
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                return `invalid glob "${glob}": ${msg}`;
            }
        }
        return null;
    }

    /**
     * Apply the configured scrub patterns to source text.
     *
     * Returns the original string (by reference) when no glob matches,
     * or a new string with every regex match replaced by spaces of
     * equal length when at least one glob matches.
     *
     * Assumes all globs and regex patterns have already been validated
     * via {@link validatePatterns}.
     *
     * @param source - The full source text of the file.
     * @param filePath - Absolute path of the file (used to test globs).
     */
    scrubFile(source: string, filePath: string): string {
        for (const glob in this.patterns) {
            if (this.getGlobMatcher(glob)(filePath)) {
                const re = this.getGlobRegex(glob, this.patterns[glob]);
                if (re) {
                    source = source.replace(re, m => ' '.repeat(m.length));
                }
            }
        }
        return source;
    }

    private getGlobMatcher(glob: string): (testPath: string) => boolean {
        let matcher = this.globMatcherCache.get(glob);
        if (!matcher) {
            matcher = picomatch(glob, { windows: true });
            this.globMatcherCache.set(glob, matcher);
        }
        return matcher;
    }

    /**
     * Get or compile the combined regex for a glob's pattern array.
     * Each pattern is wrapped in a non-capturing group before joining
     * with `|` so that internal alternation, anchors, and groups in
     * one pattern cannot bleed into adjacent patterns.
     * Returns `null` if the glob has no patterns.
     */
    private getGlobRegex(glob: string, patterns: string[]): RegExp | null {
        if (patterns.length === 0) {
            return null;
        }
        let re = this.globRegexCache.get(glob);
        if (!re) {
            const combined = patterns.map(p => `(?:${p})`).join('|');
            re = new RegExp(combined, 'g');
            this.globRegexCache.set(glob, re);
        }
        return re;
    }

    /**
     * Deep-equality check for two pattern maps.
     */
    private patternsEqual(a: FileScrubPatterns, b: FileScrubPatterns): boolean {
        const aKeys = Object.keys(a);
        const bKeys = Object.keys(b);
        if (aKeys.length !== bKeys.length) {
            return false;
        }
        for (const k of aKeys) {
            const av = a[k];
            const bv = b[k];
            if (bv === undefined || av.length !== bv.length) {
                return false;
            }
            for (let i = 0; i < av.length; i++) {
                if (av[i] !== bv[i]) {
                    return false;
                }
            }
        }
        return true;
    }
}
