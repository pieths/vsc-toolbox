// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Query parser for converting user search queries to regex patterns.
 *
 * Query Format:
 * - Space-separated terms are OR'd together
 * - `*` matches zero or more characters (within a line, doesn't cross newlines)
 * - `?` matches exactly one character (doesn't match newline)
 *
 * Examples:
 * - "options*input partSymbols" -> "options[^\n]*input|partSymbols"
 * - "get?Name" -> "get.Name"
 * - "foo bar baz" -> "foo|bar|baz"
 */

/**
 * Convert a user query string to a regex pattern string.
 *
 * @param query - User's search query with glob patterns
 * @returns Regex pattern string (without flags)
 */
export function parseQuery(query: string): string {
    const trimmed = query.trim();
    if (!trimmed) {
        return '';
    }

    const terms = trimmed.split(/\s+/);

    const regexTerms = terms.map(term => {
        // Escape regex special characters (except * and ?)
        // Special chars: . + ^ $ { } ( ) | [ ] \
        let escaped = term.replace(/[.+^${}()|[\]\\]/g, '\\$&');

        // Convert glob wildcards to regex
        // * -> [^\n]* (match anything except newline - stay within line)
        escaped = escaped.replace(/\*/g, '[^\\n]*');

        // ? -> . (match single character)
        // Note: Without the 's' (dotAll) flag, '.' does NOT match newlines,
        // so this naturally stays within a single line.
        escaped = escaped.replace(/\?/g, '.');

        return escaped;
    });

    // Join with alternation (OR)
    return regexTerms.join('|');
}
