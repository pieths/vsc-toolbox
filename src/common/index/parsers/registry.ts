// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Parser registry — maps file extensions to parser singletons.
 *
 * Lookup functions **never return `undefined`**: every file always gets
 * a parser (falling back to {@link defaultParser}), so callers never
 * need null-checks or fallback branches.
 */

import type { IFileParser } from './types';
import { defaultParser } from './defaultParser';
import { cppParser } from './cppParser';

/** All language-specific parsers (order does not matter). */
const LANGUAGE_PARSERS: readonly IFileParser[] = [
    cppParser,
];

/** Map from file extension (lower-case, with dot) to parser singleton. */
const registry = new Map<string, IFileParser>();

for (const parser of LANGUAGE_PARSERS) {
    for (const ext of parser.supportedExtensions) {
        registry.set(ext.toLowerCase(), parser);
    }
}

/**
 * Look up the parser for a given file extension.
 * Always returns a parser — falls back to {@link defaultParser} for
 * unrecognized extensions.
 *
 * @param ext - File extension including the dot (e.g. `".cc"`)
 */
export function getParserForExtension(ext: string): IFileParser {
    return registry.get(ext.toLowerCase()) ?? defaultParser;
}

/**
 * Look up the parser for a given file path.
 * Always returns a parser — falls back to {@link defaultParser}.
 *
 * @param filePath - Absolute or relative file path
 */
export function getParserForFile(filePath: string): IFileParser {
    const dot = filePath.lastIndexOf('.');
    if (dot === -1) return defaultParser;
    return getParserForExtension(filePath.substring(dot));
}

/**
 * Get all registered language-specific parsers.
 */
export function getAllParsers(): readonly IFileParser[] {
    return LANGUAGE_PARSERS;
}

export { defaultParser };
