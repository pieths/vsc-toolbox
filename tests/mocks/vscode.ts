// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Minimal mock of the `vscode` module for unit testing.
 *
 * Only the APIs used by the modules under test are stubbed here.
 * Each test can override individual properties (e.g. `window.activeTextEditor`)
 * to simulate different scenarios.
 */

// ── Core types ──────────────────────────────────────────────────────────────

export class Position {
    constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
    constructor(public readonly start: Position, public readonly end: Position) {}
}

// ── Uri ─────────────────────────────────────────────────────────────────────

export const Uri = {
    file(fsPath: string) {
        return { fsPath, scheme: 'file' };
    },
    parse(value: string) {
        try {
            const url = new URL(value);
            // Convert file:///C:/foo → C:\foo  (Windows-style)
            const fsPath = url.pathname.replace(/^\/([A-Za-z]:)/, '$1');
            return { fsPath, scheme: url.protocol.slice(0, -1) };
        } catch {
            return { fsPath: value, scheme: 'file' };
        }
    },
};

// ── Window ──────────────────────────────────────────────────────────────────

export const window: {
    activeTextEditor: any;
    showWarningMessage: (...args: any[]) => Promise<any>;
    showInformationMessage: (...args: any[]) => Promise<any>;
    showErrorMessage: (...args: any[]) => Promise<any>;
    showQuickPick: (...args: any[]) => Promise<any>;
    showTextDocument: (...args: any[]) => Promise<any>;
} = {
    activeTextEditor: undefined,
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showTextDocument: async () => undefined,
};

// ── Workspace ───────────────────────────────────────────────────────────────

export const workspace: {
    workspaceFolders: any[] | undefined;
    findFiles: (...args: any[]) => Promise<any[]>;
    openTextDocument: (...args: any[]) => Promise<any>;
    asRelativePath: (uri: any) => string;
} = {
    workspaceFolders: undefined,
    findFiles: async () => [],
    openTextDocument: async () => ({}),
    asRelativePath: (uri: any) => uri?.fsPath ?? String(uri),
};

// ── Commands ────────────────────────────────────────────────────────────────

export const commands = {
    executeCommand: async (..._args: any[]) => undefined,
};

// ── Env ─────────────────────────────────────────────────────────────────────

export const env = {
    openExternal: async (_uri: any) => true,
};

// ── Helper to reset all mocks to defaults ───────────────────────────────────

export function resetMocks() {
    window.activeTextEditor = undefined;
    window.showWarningMessage = async () => undefined;
    window.showInformationMessage = async () => undefined;
    window.showErrorMessage = async () => undefined;
    window.showQuickPick = async () => undefined;
    window.showTextDocument = async () => undefined;

    workspace.workspaceFolders = undefined;
    workspace.findFiles = async () => [];
    workspace.openTextDocument = async () => ({});
    workspace.asRelativePath = (uri: any) => uri?.fsPath ?? String(uri);

    commands.executeCommand = async () => undefined;
    env.openExternal = async () => true;
}
