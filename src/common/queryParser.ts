// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Query parser for converting user search queries to regex patterns.
 *
 * Query Format (parseQueryAsOr / parseQueryAsAnd):
 * - Space-separated terms are OR'd or AND'd together
 * - `*` matches zero or more characters (within a line, doesn't cross newlines)
 * - `?` matches exactly one character (doesn't match newline)
 *
 * Query Format (parseQueryAsAndOr):
 * - Space-separated tokens use AND semantics (all must match in a file)
 * - Parenthesized groups with `|` are OR groups: `(A|B)` means A or B
 * - Parenthesized content without `|` is treated as a literal: `(void)` matches "(void)"
 * - Each token (plain term or OR group) supports `*` and `?` glob wildcards
 * - No nesting of OR groups
 *
 * Examples:
 * - "options*input partSymbols" -> "options[^\n]*input|partSymbols"
 * - "get?Name" -> "get.Name"
 * - "foo bar baz" -> "foo|bar|baz"
 * - "(video_codec|audio_codec) MediaLogProperty" -> ["video_codec|audio_codec", "MediaLogProperty"]
 */

/**
 * Convert a single glob term to a regex pattern string.
 * Escapes regex special characters and converts `*` and `?` to regex equivalents.
 *
 * Word boundary (`\b`) rules (applied to the original term before conversion):
 * - If the first/last character is a glob wildcard (`*`), no boundary on that side.
 * - If the first/last character is a word character (`\w`), add `\b` on that side.
 * - If the first/last character is a non-word character, no boundary on that side.
 *
 * @param term - A single search term with optional glob wildcards
 * @returns Regex pattern string (without flags)
 */
function globTermToRegex(term: string): string {
    // Determine word boundaries based on the original term's first/last characters.
    // Word chars (\w) get \b to prevent substring matches (e.g., "off" won't match "offset").
    // Glob chars (*) skip the boundary to allow open-ended matching.
    // Non-word chars (e.g., -, >, .) skip the boundary since \b would be unreliable there.
    const firstChar = term[0];
    const lastChar = term[term.length - 1];
    const addLeadingBoundary = firstChar !== '*' && /\w/.test(firstChar);
    const addTrailingBoundary = lastChar !== '*' && /\w/.test(lastChar);

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

    // Apply word boundaries
    if (addLeadingBoundary) {
        escaped = '\\b' + escaped;
    }
    if (addTrailingBoundary) {
        escaped = escaped + '\\b';
    }

    return escaped;
}

/**
 * Convert a user query string to a regex pattern string.
 *
 * @param query - User's search query with glob patterns
 * @returns Regex pattern string (without flags)
 */
export function parseQueryAsOr(query: string): string {
    const trimmed = query.trim();
    if (!trimmed) {
        return '';
    }

    const terms = trimmed.split(/\s+/);

    // Join with alternation (OR)
    return terms.map(globTermToRegex).join('|');
}

/**
 * Convert a user query string to an array of regex pattern strings (AND semantics).
 * Each space-separated term becomes a separate pattern; all must match for a file to be included.
 *
 * @param query - User's search query with glob patterns
 * @returns Array of regex pattern strings (without flags)
 */
export function parseQueryAsAnd(query: string): string[] {
    const trimmed = query.trim();
    if (!trimmed) {
        return [];
    }

    const terms = trimmed.split(/\s+/);
    return terms.map(globTermToRegex);
}

/**
 * A parsed token from the query string.
 */
type Token =
    | { type: 'term'; text: string }
    | { type: 'or-group'; alternatives: string[] };

/**
 * Tokenize a query string into plain terms and OR groups.
 *
 * Walks the string character by character. When a `(` is encountered,
 * collects everything up to the matching `)`. If the parenthesized
 * content contains a `|`, it becomes an OR group; otherwise, the
 * parentheses and content are treated as a literal term.
 *
 * Space-separated segments outside parentheses are plain terms.
 *
 * @param query - Trimmed query string
 * @returns Array of parsed tokens
 */
function tokenize(query: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;

    while (i < query.length) {
        // Skip whitespace
        if (query[i] === ' ' || query[i] === '\t') {
            i++;
            continue;
        }

        if (query[i] === '(') {
            // Look for the closing paren
            const closeIdx = query.indexOf(')', i + 1);
            if (closeIdx === -1) {
                // No closing paren — treat the rest as a plain term
                tokens.push({ type: 'term', text: query.slice(i) });
                break;
            }

            const inner = query.slice(i + 1, closeIdx);

            if (inner.includes('|')) {
                // OR group: split on | and trim each alternative
                const alternatives = inner.split('|').map(s => s.trim()).filter(s => s.length > 0);
                if (alternatives.length > 0) {
                    tokens.push({ type: 'or-group', alternatives });
                }
            } else {
                // No pipe — treat the parenthesized content as literal text including parens
                tokens.push({ type: 'term', text: query.slice(i, closeIdx + 1) });
            }

            i = closeIdx + 1;
        } else {
            // Plain term: collect until whitespace
            const start = i;
            while (i < query.length && query[i] !== ' ' && query[i] !== '\t') {
                i++;
            }
            tokens.push({ type: 'term', text: query.slice(start, i) });
        }
    }

    return tokens;
}

/**
 * Convert a user query string to an array of regex pattern strings with AND/OR semantics.
 *
 * Tokens are space-separated and use AND semantics (all must match in a file).
 * A token can be:
 * - A plain term: `foo`, `Get*Configs`, `D3D1?`
 * - An OR group: `(termA|termB)` — matches if any sub-term matches
 *
 * If parenthesized content does not contain a `|`, it is treated as a literal
 * string (e.g., `(void)` matches the text "(void)").
 *
 * Each sub-term within an OR group supports `*` and `?` glob wildcards.
 *
 * @param query - User's search query
 * @returns Array of regex pattern strings (without flags), one per AND group
 */
export function parseQueryAsAndOr(query: string): string[] {
    const trimmed = query.trim();
    if (!trimmed) {
        return [];
    }

    const tokens = tokenize(trimmed);

    return tokens.map(token => {
        if (token.type === 'or-group') {
            // OR group: convert each alternative to regex and join with |
            return token.alternatives.map(globTermToRegex).join('|');
        } else {
            // Plain term (including literal parenthesized content)
            return globTermToRegex(token.text);
        }
    });
}
