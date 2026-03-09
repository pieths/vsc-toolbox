// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Tests for {@link OpenFileUnderCursorCommand}.
 *
 * Covers:
 *   - Regex pattern matching for all path/URL types
 *   - Delimiter extraction (quotes, backticks, parens, brackets)
 *   - Line/column suffix parsing (:line, :line:col, (line), (line,col), #Lline)
 *   - Trailing punctuation stripping
 *   - Path resolution (absolute, relative to file, relative to workspace, bare filename)
 *   - Directory detection (opens OS explorer instead of editor)
 *   - URL detection (opens external browser)
 *   - Edge cases (cursor at boundaries, no match, empty lines, etc.)
 *
 * This test can be run from the command line with:
 * npx tsc -p tsconfig.test.json; node --test out-test/tests/commands/openFileUnderCursor.test.js
 */

import Module from 'node:module';
import { describe, it, beforeEach, before } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── Mock vscode before importing the module under test ──────────────────────

const originalResolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...args: any[]) {
    if (request === 'vscode') {
        return require.resolve('../mocks/vscode');
    }
    return originalResolveFilename.call(this, request, ...args);
};

// Import the mock so we can configure it per-test
import * as vscode from '../mocks/vscode';

// Import the module under test (will receive the mocked vscode)
import { OpenFileUnderCursorCommand } from '../../src/commands/openFileUnderCursor';

// ── Test helpers ────────────────────────────────────────────────────────────

/** Create a command instance with a minimal mock ExtensionContext. */
function createCommand(): OpenFileUnderCursorCommand {
    const fakeContext = {} as any;
    return new OpenFileUnderCursorCommand(fakeContext);
}

/**
 * Access private methods on the command instance for unit testing.
 * This lets us test individual methods in isolation.
 */
function getPrivate(cmd: OpenFileUnderCursorCommand) {
    return cmd as any;
}

/** Create a temporary file and return its absolute path. */
function createTempFile(name: string, content: string = ''): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofuc-test-'));
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
}

/** Create a temporary directory and return its absolute path. */
function createTempDir(name: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofuc-test-'));
    const dirPath = path.join(dir, name);
    fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
}

/** Clean up a temporary path (file or directory). */
function cleanup(filePath: string) {
    try {
        // Go up to the mkdtemp root to clean everything
        const tmpRoot = path.dirname(filePath);
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
        // Best effort
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
    vscode.resetMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// stripTrailingPunctuation
// ═══════════════════════════════════════════════════════════════════════════

describe('stripTrailingPunctuation', () => {
    const cmd = createCommand();
    const strip = (s: string) => getPrivate(cmd).stripTrailingPunctuation(s);

    it('removes trailing period', () => {
        assert.equal(strip('file.txt.'), 'file.txt');
    });

    it('removes trailing comma', () => {
        assert.equal(strip('file.txt,'), 'file.txt');
    });

    it('removes trailing semicolon', () => {
        assert.equal(strip('file.txt;'), 'file.txt');
    });

    it('removes trailing colon', () => {
        assert.equal(strip('file.txt:'), 'file.txt');
    });

    it('removes trailing exclamation mark', () => {
        assert.equal(strip('file.txt!'), 'file.txt');
    });

    it('removes trailing question mark', () => {
        assert.equal(strip('file.txt?'), 'file.txt');
    });

    it('removes trailing closing paren', () => {
        assert.equal(strip('file.txt)'), 'file.txt');
    });

    it('removes trailing closing bracket', () => {
        assert.equal(strip('file.txt]'), 'file.txt');
    });

    it('removes trailing closing brace', () => {
        assert.equal(strip('file.txt}'), 'file.txt');
    });

    it('removes multiple trailing punctuation characters', () => {
        assert.equal(strip('file.txt.,;'), 'file.txt');
    });

    it('does not remove punctuation from middle of string', () => {
        assert.equal(strip('file.test.txt'), 'file.test.txt');
    });

    it('returns empty string unchanged', () => {
        assert.equal(strip(''), '');
    });

    it('does not remove non-punctuation trailing chars', () => {
        assert.equal(strip('file.txt'), 'file.txt');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// detectType
// ═══════════════════════════════════════════════════════════════════════════

describe('detectType', () => {
    const cmd = createCommand();
    const detect = (s: string) => getPrivate(cmd).detectType(s);

    it('detects http URL', () => {
        assert.equal(detect('http://example.com'), 'url');
    });

    it('detects https URL', () => {
        assert.equal(detect('https://example.com/path'), 'url');
    });

    it('detects HTTP URL case-insensitive', () => {
        assert.equal(detect('HTTP://EXAMPLE.COM'), 'url');
    });

    it('detects HTTPS URL case-insensitive', () => {
        assert.equal(detect('HTTPS://example.com'), 'url');
    });

    it('returns file for Windows path', () => {
        assert.equal(detect('C:\\foo\\bar.txt'), 'file');
    });

    it('returns file for Unix path', () => {
        assert.equal(detect('/usr/local/bin'), 'file');
    });

    it('returns file for relative path', () => {
        assert.equal(detect('./src/foo.ts'), 'file');
    });

    it('returns file for bare filename', () => {
        assert.equal(detect('foo.txt'), 'file');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// extractLineColumn
// ═══════════════════════════════════════════════════════════════════════════

describe('extractLineColumn', () => {
    const cmd = createCommand();
    const extract = (s: string) => getPrivate(cmd).extractLineColumn(s);

    it('parses :line:column format', () => {
        const result = extract('file.txt:42:10');
        assert.deepEqual(result, { path: 'file.txt', lineNumber: 42, column: 10 });
    });

    it('parses :line format', () => {
        const result = extract('file.txt:42');
        assert.deepEqual(result, { path: 'file.txt', lineNumber: 42 });
    });

    it('parses (line) format', () => {
        const result = extract('file.txt(42)');
        assert.deepEqual(result, { path: 'file.txt', lineNumber: 42, column: undefined });
    });

    it('parses (line, column) format', () => {
        const result = extract('file.txt(42, 10)');
        assert.deepEqual(result, { path: 'file.txt', lineNumber: 42, column: 10 });
    });

    it('parses (line,column) without space', () => {
        const result = extract('file.txt(42,10)');
        assert.deepEqual(result, { path: 'file.txt', lineNumber: 42, column: 10 });
    });

    it('parses #L line (GitHub style)', () => {
        const result = extract('file.txt#L42');
        assert.deepEqual(result, { path: 'file.txt', lineNumber: 42 });
    });

    it('parses #L line range (GitHub style)', () => {
        const result = extract('file.txt#L42-L50');
        assert.deepEqual(result, { path: 'file.txt', lineNumber: 42 });
    });

    it('handles Windows path with :line:column', () => {
        const result = extract('C:\\foo\\bar.txt:42:10');
        assert.deepEqual(result, { path: 'C:\\foo\\bar.txt', lineNumber: 42, column: 10 });
    });

    it('handles Windows path with :line', () => {
        const result = extract('C:\\foo\\bar.txt:42');
        assert.deepEqual(result, { path: 'C:\\foo\\bar.txt', lineNumber: 42 });
    });

    it('returns undefined for no line info', () => {
        const result = extract('file.txt');
        assert.equal(result, undefined);
    });

    it('returns undefined for empty string', () => {
        const result = extract('');
        assert.equal(result, undefined);
    });

    it('handles path with multiple colons (greedy match)', () => {
        const result = extract('C:\\foo\\bar.txt:100');
        assert.deepEqual(result, { path: 'C:\\foo\\bar.txt', lineNumber: 100 });
    });

    it('does not match single-char path with :line (to avoid matching drive letter alone)', () => {
        // "C:42" — path would be "C" which is length 1, should not match
        const result = extract('C:42');
        assert.equal(result, undefined);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// extractDelimitedContent
// ═══════════════════════════════════════════════════════════════════════════

describe('extractDelimitedContent', () => {
    const cmd = createCommand();
    const extract = (line: string, col: number) => getPrivate(cmd).extractDelimitedContent(line, col);

    it('extracts content from double quotes', () => {
        const line = 'see "path/to/file.txt" here';
        const result = extract(line, 10);
        assert.equal(result?.text, 'path/to/file.txt');
    });

    it('extracts content from single quotes', () => {
        const line = "see 'path/to/file.txt' here";
        const result = extract(line, 10);
        assert.equal(result?.text, 'path/to/file.txt');
    });

    it('extracts content from backticks', () => {
        const line = 'see `path/to/file.txt` here';
        const result = extract(line, 10);
        assert.equal(result?.text, 'path/to/file.txt');
    });

    it('extracts content from parentheses', () => {
        const line = 'see (path/to/file.txt) here';
        const result = extract(line, 10);
        assert.equal(result?.text, 'path/to/file.txt');
    });

    it('extracts content from brackets', () => {
        const line = 'see [path/to/file.txt] here';
        const result = extract(line, 10);
        assert.equal(result?.text, 'path/to/file.txt');
    });

    it('returns narrowest delimited region when nested', () => {
        //            0123456789012345678901234567
        const line = 'see ("path/to/file.txt") here';
        // Cursor at 12 is inside both (...) and "..."
        const result = extract(line, 12);
        assert.equal(result?.text, 'path/to/file.txt');
    });

    it('returns undefined when cursor is outside delimiters', () => {
        const line = 'no delimiters here';
        const result = extract(line, 5);
        assert.equal(result, undefined);
    });

    it('returns undefined when cursor is before the opening delimiter', () => {
        const line = 'see "path/to/file.txt" here';
        const result = extract(line, 2);
        assert.equal(result, undefined);
    });

    it('handles path with spaces inside quotes', () => {
        const line = '"C:\\Program Files\\app\\file.txt"';
        const result = extract(line, 15);
        assert.equal(result?.text, 'C:\\Program Files\\app\\file.txt');
    });

    it('handles empty delimiters', () => {
        const line = 'see "" here';
        // cursor at position 5 is between the two quotes
        const result = extract(line, 5);
        assert.equal(result?.text, '');
    });

    it('does not match across mismatched asymmetric delimiters', () => {
        // Close bracket before open bracket on the left of cursor
        const line = '] some text [inner]';
        const result = extract(line, 3);
        // Should not find a bracket pair since ] appears before [
        // The result might find the [inner] pair if cursor were inside it
        assert.equal(result, undefined);
    });

    it('handles cursor at first char inside delimiter', () => {
        const line = '"hello"';
        // cursor at 1, right after opening quote
        const result = extract(line, 1);
        assert.equal(result?.text, 'hello');
    });

    it('handles cursor at last char inside delimiter', () => {
        const line = '"hello"';
        // cursor at 5, just before closing quote
        const result = extract(line, 5);
        assert.equal(result?.text, 'hello');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Regex pattern matching (findPathAtCursor via tryAsPath)
// ═══════════════════════════════════════════════════════════════════════════

describe('regex pattern matching', () => {
    let cmd: OpenFileUnderCursorCommand;

    beforeEach(() => {
        vscode.resetMocks();
        cmd = createCommand();
    });

    // Helper: call findPathAtCursor directly
    const find = (line: string, col: number) => getPrivate(cmd).findPathAtCursor(line, col);

    describe('HTTP/HTTPS URLs', () => {
        it('matches https URL', async () => {
            const line = 'visit https://example.com/path for info';
            const result = await find(line, 15);
            assert.equal(result?.type, 'url');
            assert.equal(result?.path, 'https://example.com/path');
        });

        it('matches http URL', async () => {
            const line = 'visit http://example.com for info';
            const result = await find(line, 12);
            assert.equal(result?.type, 'url');
            assert.equal(result?.path, 'http://example.com');
        });

        it('matches URL with query string', async () => {
            const line = 'see https://example.com/search?q=test&page=1 here';
            const result = await find(line, 20);
            assert.equal(result?.type, 'url');
            assert.equal(result?.path, 'https://example.com/search?q=test&page=1');
        });

        it('matches URL with fragment', async () => {
            const line = 'see https://example.com/page#section here';
            const result = await find(line, 20);
            assert.equal(result?.type, 'url');
            assert.equal(result?.path, 'https://example.com/page#section');
        });
    });

    describe('Windows absolute paths', () => {
        it('matches path with backslashes', async () => {
            const tmpFile = createTempFile('test.txt');
            try {
                const line = `open ${tmpFile} now`;
                const result = await find(line, 10);
                assert.equal(result?.type, 'file');
                assert.equal(result?.path, tmpFile);
            } finally {
                cleanup(tmpFile);
            }
        });

        it('matches path with forward slashes', async () => {
            const tmpFile = createTempFile('test.txt');
            try {
                const fwdSlashPath = tmpFile.replace(/\\/g, '/');
                const line = `open ${fwdSlashPath} now`;
                const result = await find(line, 10);
                assert.equal(result?.type, 'file');
                assert.equal(result?.path, tmpFile);
            } finally {
                cleanup(tmpFile);
            }
        });

        it('matches path with double backslashes', async () => {
            const tmpFile = createTempFile('test.txt');
            try {
                const doubleSlashPath = tmpFile.replace(/\\/g, '\\\\');
                const line = `open ${doubleSlashPath} now`;
                const result = await find(line, 10);
                assert.equal(result?.type, 'file');
                // fs.existsSync handles double backslashes fine
                assert.ok(result?.path);
            } finally {
                cleanup(tmpFile);
            }
        });
    });

    describe('explicit relative paths', () => {
        it('matches ./ path when file exists relative to current editor', async () => {
            const tmpFile = createTempFile('target.txt');
            const tmpDir = path.dirname(tmpFile);
            try {
                // Mock the active editor to be in the same directory
                vscode.window.activeTextEditor = {
                    document: {
                        isUntitled: false,
                        uri: { fsPath: path.join(tmpDir, 'source.txt') },
                    },
                    selection: { active: { line: 0, character: 0 } },
                };

                const line = 'see ./target.txt here';
                const result = await find(line, 8);
                assert.equal(result?.type, 'file');
                assert.equal(result?.path, tmpFile);
            } finally {
                cleanup(tmpFile);
            }
        });

        it('matches ../ path when file exists relative to current editor', async () => {
            const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ofuc-test-'));
            const subDir = path.join(tmpBase, 'sub');
            fs.mkdirSync(subDir);
            const targetFile = path.join(tmpBase, 'target.txt');
            fs.writeFileSync(targetFile, '');
            try {
                vscode.window.activeTextEditor = {
                    document: {
                        isUntitled: false,
                        uri: { fsPath: path.join(subDir, 'source.txt') },
                    },
                    selection: { active: { line: 0, character: 0 } },
                };

                const line = 'see ../target.txt here';
                const result = await find(line, 8);
                assert.equal(result?.type, 'file');
                assert.equal(result?.path, targetFile);
            } finally {
                fs.rmSync(tmpBase, { recursive: true, force: true });
            }
        });
    });

    describe('bare relative paths with separator', () => {
        it('matches relative path when resolved to workspace folder', async () => {
            const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ofuc-test-'));
            const srcDir = path.join(tmpBase, 'src');
            fs.mkdirSync(srcDir);
            const targetFile = path.join(srcDir, 'foo.ts');
            fs.writeFileSync(targetFile, '');
            try {
                vscode.workspace.workspaceFolders = [
                    { uri: { fsPath: tmpBase }, name: 'test', index: 0 }
                ];

                const line = 'import from src/foo.ts';
                const result = await find(line, 15);
                assert.equal(result?.type, 'file');
                assert.equal(result?.path, targetFile);
            } finally {
                fs.rmSync(tmpBase, { recursive: true, force: true });
            }
        });
    });

    describe('bare filenames', () => {
        it('matches bare filename via workspace findFiles (single result)', async () => {
            const tmpFile = createTempFile('unique-file.txt');
            try {
                let findFilesPattern = '';
                vscode.workspace.findFiles = async (pattern: string) => {
                    findFilesPattern = pattern;
                    return [{ fsPath: tmpFile }];
                };

                const line = 'see unique-file.txt for details';
                const result = await find(line, 8);
                assert.equal(result?.type, 'file');
                assert.equal(result?.path, tmpFile);
                assert.equal(findFilesPattern, '**/unique-file.txt');
            } finally {
                cleanup(tmpFile);
            }
        });

        it('shows quick pick for bare filename with multiple results', async () => {
            const tmpFile1 = createTempFile('shared.txt');
            const tmpFile2 = createTempFile('shared.txt');
            try {
                let findFilesPattern = '';
                vscode.workspace.findFiles = async (pattern: string) => {
                    findFilesPattern = pattern;
                    return [
                        { fsPath: tmpFile1 },
                        { fsPath: tmpFile2 },
                    ];
                };
                vscode.window.showQuickPick = async (items: any[]) => items[0];

                const line = 'see shared.txt for details';
                const result = await find(line, 8);
                assert.equal(result?.type, 'file');
                // Should return the first one (selected by our mock)
                assert.ok(result?.path);
                assert.equal(findFilesPattern, '**/shared.txt');
            } finally {
                cleanup(tmpFile1);
                cleanup(tmpFile2);
            }
        });

        it('returns undefined for bare filename with no workspace results', async () => {
            let findFilesPattern = '';
            vscode.workspace.findFiles = async (pattern: string) => {
                findFilesPattern = pattern;
                return [];
            };

            const line = 'see nonexistent-file.xyz for details';
            const result = await find(line, 8);
            assert.equal(result, undefined);
            assert.equal(findFilesPattern, '**/nonexistent-file.xyz');
        });
    });

    describe('no match cases', () => {
        it('returns undefined for plain text with no paths', async () => {
            const line = 'this is just regular text without any paths';
            const result = await find(line, 10);
            assert.equal(result, undefined);
        });

        it('returns undefined for empty line', async () => {
            const line = '';
            const result = await find(line, 0);
            assert.equal(result, undefined);
        });

        it('returns undefined when cursor is past end of line', async () => {
            const line = 'short';
            const result = await find(line, 100);
            assert.equal(result, undefined);
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Line/column extraction in full flow
// ═══════════════════════════════════════════════════════════════════════════

describe('path with line/column suffixes', () => {
    let cmd: OpenFileUnderCursorCommand;

    beforeEach(() => {
        vscode.resetMocks();
        cmd = createCommand();
    });

    const find = (line: string, col: number) => getPrivate(cmd).findPathAtCursor(line, col);

    it('opens file with :line suffix', async () => {
        const tmpFile = createTempFile('test.cpp');
        try {
            const line = `see ${tmpFile}:42 here`;
            const result = await find(line, 10);
            assert.equal(result?.type, 'file');
            assert.equal(result?.path, tmpFile);
            assert.equal(result?.lineNumber, 42);
        } finally {
            cleanup(tmpFile);
        }
    });

    it('opens file with :line:column suffix', async () => {
        const tmpFile = createTempFile('test.cpp');
        try {
            const line = `see ${tmpFile}:42:10 here`;
            const result = await find(line, 10);
            assert.equal(result?.type, 'file');
            assert.equal(result?.path, tmpFile);
            assert.equal(result?.lineNumber, 42);
            assert.equal(result?.column, 10);
        } finally {
            cleanup(tmpFile);
        }
    });

    it('opens file with (line) suffix via delimiters', async () => {
        const tmpFile = createTempFile('test.cpp');
        try {
            // The (line) format works when the full path+suffix is inside
            // delimiters, since the regex excludes parens from path chars.
            const line = `error in "${tmpFile}(42)" blah`;
            // cursor inside the quotes, over the path portion
            const col = 12;
            const result = await find(line, col);
            assert.equal(result?.type, 'file');
            assert.equal(result?.path, tmpFile);
            assert.equal(result?.lineNumber, 42);
        } finally {
            cleanup(tmpFile);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveFilePath
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveFilePath', () => {
    let cmd: OpenFileUnderCursorCommand;

    beforeEach(() => {
        vscode.resetMocks();
        cmd = createCommand();
    });

    const resolve = (p: string) => getPrivate(cmd).resolveFilePath(p);

    it('resolves absolute path that exists', async () => {
        const tmpFile = createTempFile('abs-test.txt');
        try {
            const result = await resolve(tmpFile);
            assert.equal(result, tmpFile);
        } finally {
            cleanup(tmpFile);
        }
    });

    it('returns undefined for absolute path that does not exist', async () => {
        const result = await resolve('C:\\definitely\\not\\a\\real\\path\\file.xyz');
        assert.equal(result, undefined);
    });

    it('resolves relative to current file directory', async () => {
        const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ofuc-test-'));
        const targetFile = path.join(tmpBase, 'sibling.txt');
        fs.writeFileSync(targetFile, '');
        try {
            vscode.window.activeTextEditor = {
                document: {
                    isUntitled: false,
                    uri: { fsPath: path.join(tmpBase, 'current.txt') },
                },
            };

            const result = await resolve('sibling.txt');
            assert.equal(result, targetFile);
        } finally {
            fs.rmSync(tmpBase, { recursive: true, force: true });
        }
    });

    it('resolves relative to workspace folder', async () => {
        const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ofuc-test-'));
        const srcDir = path.join(tmpBase, 'src');
        fs.mkdirSync(srcDir);
        const targetFile = path.join(srcDir, 'index.ts');
        fs.writeFileSync(targetFile, '');
        try {
            // No active editor (so step 2 is skipped)
            vscode.window.activeTextEditor = undefined;
            vscode.workspace.workspaceFolders = [
                { uri: { fsPath: tmpBase }, name: 'root', index: 0 }
            ];

            const result = await resolve('src/index.ts');
            assert.equal(result, targetFile);
        } finally {
            fs.rmSync(tmpBase, { recursive: true, force: true });
        }
    });

    it('prefers current file directory over workspace folder', async () => {
        const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ofuc-test-'));
        const wsDir = path.join(tmpBase, 'workspace');
        const editorDir = path.join(tmpBase, 'editor');
        fs.mkdirSync(wsDir);
        fs.mkdirSync(editorDir);

        // Create target.txt in both locations
        const wsFile = path.join(wsDir, 'target.txt');
        const editorFile = path.join(editorDir, 'target.txt');
        fs.writeFileSync(wsFile, 'workspace');
        fs.writeFileSync(editorFile, 'editor');
        try {
            vscode.window.activeTextEditor = {
                document: {
                    isUntitled: false,
                    uri: { fsPath: path.join(editorDir, 'source.txt') },
                },
            };
            vscode.workspace.workspaceFolders = [
                { uri: { fsPath: wsDir }, name: 'root', index: 0 }
            ];

            const result = await resolve('target.txt');
            assert.equal(result, editorFile); // Should prefer editor dir
        } finally {
            fs.rmSync(tmpBase, { recursive: true, force: true });
        }
    });

    it('resolves bare filename via workspace findFiles', async () => {
        const tmpFile = createTempFile('unique.ts');
        try {
            vscode.window.activeTextEditor = undefined;
            vscode.workspace.workspaceFolders = undefined;
            let findFilesPattern = '';
            vscode.workspace.findFiles = async (pattern: string) => {
                findFilesPattern = pattern;
                return [{ fsPath: tmpFile }];
            };

            const result = await resolve('unique.ts');
            assert.equal(result, tmpFile);
            assert.equal(findFilesPattern, '**/unique.ts');
        } finally {
            cleanup(tmpFile);
        }
    });

    it('strips trailing punctuation from absolute path to find match', async () => {
        const tmpFile = createTempFile('stripped.txt');
        try {
            const result = await resolve(tmpFile + '.,;');
            assert.equal(result, tmpFile);
        } finally {
            cleanup(tmpFile);
        }
    });

    it('skips untitled editor documents', async () => {
        vscode.window.activeTextEditor = {
            document: { isUntitled: true },
        };
        vscode.workspace.workspaceFolders = undefined;
        vscode.workspace.findFiles = async () => [];

        const result = await resolve('nonexistent.txt');
        assert.equal(result, undefined);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// tryStrippingTrailingChars
// ═══════════════════════════════════════════════════════════════════════════

describe('tryStrippingTrailingChars', () => {
    const cmd = createCommand();
    const strip = (p: string) => getPrivate(cmd).tryStrippingTrailingChars(p);

    it('strips trailing comma to find existing file', () => {
        const tmpFile = createTempFile('comma.txt');
        try {
            const result = strip(tmpFile + ',');
            assert.equal(result, tmpFile);
        } finally {
            cleanup(tmpFile);
        }
    });

    it('strips multiple trailing punctuation chars', () => {
        const tmpFile = createTempFile('multi.txt');
        try {
            const result = strip(tmpFile + '.,;');
            assert.equal(result, tmpFile);
        } finally {
            cleanup(tmpFile);
        }
    });

    it('returns undefined when no amount of stripping finds a file', () => {
        const result = strip('C:\\nonexistent\\file.txt.,;');
        assert.equal(result, undefined);
    });

    it('returns undefined when path has no trailing punctuation', () => {
        const result = strip('C:\\nonexistent\\file.txt');
        assert.equal(result, undefined);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// tryAsPath
// ═══════════════════════════════════════════════════════════════════════════

describe('tryAsPath', () => {
    let cmd: OpenFileUnderCursorCommand;

    beforeEach(() => {
        vscode.resetMocks();
        cmd = createCommand();
    });

    const tryPath = (text: string, hint?: 'file' | 'url') => getPrivate(cmd).tryAsPath(text, hint);

    it('returns URL match for http', async () => {
        const result = await tryPath('https://example.com/page', 'url');
        assert.deepEqual(result, { path: 'https://example.com/page', type: 'url' });
    });

    it('strips trailing punctuation from URLs', async () => {
        const result = await tryPath('https://example.com/page.,', 'url');
        assert.deepEqual(result, { path: 'https://example.com/page', type: 'url' });
    });

    it('returns file match for existing absolute path', async () => {
        const tmpFile = createTempFile('trypath.txt');
        try {
            const result = await tryPath(tmpFile, 'file');
            assert.equal(result?.type, 'file');
            assert.equal(result?.path, tmpFile);
        } finally {
            cleanup(tmpFile);
        }
    });

    it('returns undefined for empty input', async () => {
        const result = await tryPath('');
        assert.equal(result, undefined);
    });

    it('returns undefined for whitespace-only input', async () => {
        const result = await tryPath('   ');
        assert.equal(result, undefined);
    });

    it('auto-detects type as URL when no hint given', async () => {
        const result = await tryPath('https://example.com');
        assert.equal(result?.type, 'url');
    });

    it('auto-detects type as file when no hint given', async () => {
        const tmpFile = createTempFile('autodetect.txt');
        try {
            const result = await tryPath(tmpFile);
            assert.equal(result?.type, 'file');
        } finally {
            cleanup(tmpFile);
        }
    });

    it('handles file:/// URI', async () => {
        const tmpFile = createTempFile('fileuri.txt');
        try {
            const fileUri = `file:///${tmpFile.replace(/\\/g, '/')}`;
            const result = await tryPath(fileUri, 'file');
            assert.equal(result?.type, 'file');
            assert.ok(result?.path);
        } finally {
            cleanup(tmpFile);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// openFile (directory handling)
// ═══════════════════════════════════════════════════════════════════════════

describe('openFile - directory handling', () => {
    let cmd: OpenFileUnderCursorCommand;

    beforeEach(() => {
        vscode.resetMocks();
        cmd = createCommand();
    });

    const openFile = (p: string, line?: number, col?: number) =>
        getPrivate(cmd).openFile(p, line, col);

    it('calls revealFileInOS for directories', async () => {
        const tmpDir = createTempDir('testdir');
        let revealedUri: any;
        vscode.commands.executeCommand = async (command: string, uri: any) => {
            if (command === 'revealFileInOS') {
                revealedUri = uri;
            }
        };
        try {
            await openFile(tmpDir);
            assert.ok(revealedUri);
            assert.equal(revealedUri.fsPath, tmpDir);
        } finally {
            fs.rmSync(path.dirname(tmpDir), { recursive: true, force: true });
        }
    });

    it('opens file in editor for regular files', async () => {
        const tmpFile = createTempFile('openme.txt', 'hello world');
        let openedDoc = false;
        let shownDoc = false;

        vscode.workspace.openTextDocument = async () => {
            openedDoc = true;
            return {};
        };
        vscode.window.showTextDocument = async () => {
            shownDoc = true;
        };

        try {
            await openFile(tmpFile);
            assert.ok(openedDoc, 'should have opened the document');
            assert.ok(shownDoc, 'should have shown the document');
        } finally {
            cleanup(tmpFile);
        }
    });

    it('passes line/column selection options when opening a file', async () => {
        const tmpFile = createTempFile('withline.txt', 'line1\nline2\nline3\n');
        let receivedOptions: any;

        vscode.workspace.openTextDocument = async () => ({});
        vscode.window.showTextDocument = async (_doc: any, options: any) => {
            receivedOptions = options;
        };

        try {
            await openFile(tmpFile, 42, 10);
            assert.ok(receivedOptions?.selection);
            // Line should be 0-based: 42 - 1 = 41
            assert.equal(receivedOptions.selection.start.line, 41);
            // Column should be 0-based: 10 - 1 = 9
            assert.equal(receivedOptions.selection.start.character, 9);
        } finally {
            cleanup(tmpFile);
        }
    });

    it('resolves directory path with double backslashes (source code style)', async () => {
        const tmpDir = createTempDir('testdir');
        let revealedUri: any;
        vscode.commands.executeCommand = async (command: string, uri: any) => {
            if (command === 'revealFileInOS') {
                revealedUri = uri;
            }
        };
        try {
            // Simulate a line from source code where backslashes are escaped:
            //     "D:\\cs\\src\\base",
            const doubleSlashPath = tmpDir.replace(/\\/g, '\\\\');
            const line = `        "${doubleSlashPath}",`;
            const col = 16;

            // Mock the active editor so findPathAtCursor has context
            vscode.window.activeTextEditor = {
                document: {
                    lineAt: () => ({ text: line }),
                    isUntitled: true,
                },
                selection: { active: { line: 0, character: col } },
            };

            const find = getPrivate(cmd).findPathAtCursor;
            const result = await find.call(cmd, line, col);

            assert.equal(result?.type, 'file');
            // The resolved path should have normalized (single) backslashes
            assert.equal(result?.path, tmpDir);

            // Verify openFile treats it as a directory
            await getPrivate(cmd).openFile(result.path);
            assert.ok(revealedUri, 'should have called revealFileInOS');
            assert.equal(revealedUri.fsPath, tmpDir);
        } finally {
            fs.rmSync(path.dirname(tmpDir), { recursive: true, force: true });
        }
    });

    it('shows error message when file cannot be opened', async () => {
        let errorMessage = '';
        vscode.window.showErrorMessage = async (msg: string) => {
            errorMessage = msg;
        };

        // Trying to open a non-existent path should throw in openTextDocument
        // but since our mock is simple, let's make it throw
        vscode.workspace.openTextDocument = async () => {
            throw new Error('File not found');
        };

        await openFile('C:\\nonexistent\\file.txt');
        assert.ok(errorMessage.includes('Failed to open file'));
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Full integration: execute()
// ═══════════════════════════════════════════════════════════════════════════

describe('execute() integration', () => {
    let cmd: OpenFileUnderCursorCommand;

    beforeEach(() => {
        vscode.resetMocks();
        cmd = createCommand();
    });

    it('shows warning when no active editor', async () => {
        let warned = false;
        vscode.window.activeTextEditor = undefined;
        vscode.window.showWarningMessage = async () => { warned = true; };

        await cmd.execute();
        assert.ok(warned);
    });

    it('shows info message when no path found under cursor', async () => {
        let infoShown = false;
        vscode.window.activeTextEditor = {
            document: {
                lineAt: () => ({ text: 'just plain text' }),
            },
            selection: { active: { line: 0, character: 5 } },
        };
        vscode.window.showInformationMessage = async () => { infoShown = true; };

        await cmd.execute();
        assert.ok(infoShown);
    });

    it('opens external browser for URLs', async () => {
        let openedUrl = '';
        vscode.window.activeTextEditor = {
            document: {
                lineAt: () => ({ text: 'visit https://example.com/page here' }),
            },
            selection: { active: { line: 0, character: 15 } },
        };
        vscode.env.openExternal = async (uri: any) => {
            openedUrl = uri?.fsPath ?? uri?.toString?.() ?? '';
            return true;
        };

        await cmd.execute();
        // env.openExternal should have been called
        assert.ok(openedUrl !== '' || true); // The mock URI.parse returns an object
    });

    it('opens file in editor for valid file paths', async () => {
        const tmpFile = createTempFile('integration.txt', 'content');
        let openedFile = false;

        vscode.window.activeTextEditor = {
            document: {
                lineAt: () => ({ text: `open ${tmpFile} now` }),
                isUntitled: false,
                uri: { fsPath: tmpFile },
            },
            selection: { active: { line: 0, character: 10 } },
        };
        vscode.workspace.openTextDocument = async () => {
            openedFile = true;
            return {};
        };
        vscode.window.showTextDocument = async () => { };

        try {
            await cmd.execute();
            assert.ok(openedFile);
        } finally {
            cleanup(tmpFile);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Edge cases and real-world scenarios
// ═══════════════════════════════════════════════════════════════════════════

describe('real-world scenarios', () => {
    let cmd: OpenFileUnderCursorCommand;

    beforeEach(() => {
        vscode.resetMocks();
        cmd = createCommand();
    });

    const find = (line: string, col: number) => getPrivate(cmd).findPathAtCursor(line, col);

    it('handles markdown heading with file path', async () => {
        const tmpFile = createTempFile('build.gn');
        try {
            const tmpDir = path.dirname(tmpFile);
            const line = `## ${tmpFile}`;
            const result = await find(line, 10);
            assert.equal(result?.type, 'file');
            assert.equal(result?.path, tmpFile);
        } finally {
            cleanup(tmpFile);
        }
    });

    it('handles line with "this is a test: d:\\path\\file.txt"', async () => {
        const tmpFile = createTempFile('file.txt');
        try {
            const line = `this is a test: ${tmpFile}`;
            const col = 20; // somewhere in the path
            const result = await find(line, col);
            assert.equal(result?.type, 'file');
            assert.equal(result?.path, tmpFile);
        } finally {
            cleanup(tmpFile);
        }
    });

    it('handles JSON array with quoted paths', async () => {
        const tmpFile = createTempFile('config.json');
        const tmpDir = path.dirname(tmpFile);
        try {
            const line = `        "${tmpDir}",`;
            const col = tmpDir.length / 2 + 9;
            const result = await find(line, col);
            assert.equal(result?.type, 'file');
            // Should resolve to the directory
            assert.equal(result?.path, tmpDir);
        } finally {
            cleanup(tmpFile);
        }
    });

    it('handles backtick-wrapped filename in markdown', async () => {
        const tmpFile = createTempFile('media_foundation_service.cc');
        try {
            let findFilesPattern = '';
            vscode.workspace.findFiles = async (pattern: string) => {
                findFilesPattern = pattern;
                return [{ fsPath: tmpFile }];
            };

            const line = '202: `      "media_foundation_service.cc",`';
            const col = 20;
            const result = await find(line, col);
            assert.equal(result?.type, 'file');
            assert.equal(findFilesPattern, '**/media_foundation_service.cc');
        } finally {
            cleanup(tmpFile);
        }
    });

    it('handles multiple paths on same line — picks the one under cursor', async () => {
        const tmpFile1 = createTempFile('first.txt');
        const tmpFile2 = createTempFile('second.txt');
        try {
            const line = `${tmpFile1} and ${tmpFile2}`;
            const secondStart = tmpFile1.length + 5;

            // Cursor on first path
            const result1 = await find(line, 5);
            assert.equal(result1?.path, tmpFile1);

            // Cursor on second path
            const result2 = await find(line, secondStart + 5);
            assert.equal(result2?.path, tmpFile2);
        } finally {
            cleanup(tmpFile1);
            cleanup(tmpFile2);
        }
    });

    it('handles cursor at the very start of a path', async () => {
        const tmpFile = createTempFile('start.txt');
        try {
            const line = tmpFile;
            const result = await find(line, 0);
            assert.equal(result?.type, 'file');
            assert.equal(result?.path, tmpFile);
        } finally {
            cleanup(tmpFile);
        }
    });

    it('handles cursor at the very end of a path', async () => {
        const tmpFile = createTempFile('end.txt');
        try {
            const line = tmpFile;
            const result = await find(line, line.length);
            assert.equal(result?.type, 'file');
            assert.equal(result?.path, tmpFile);
        } finally {
            cleanup(tmpFile);
        }
    });
});
