// Copyright (c) 2025 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Get File Name Command - Copies the current file name to clipboard
 */
export class GetFileNameCommand {
    public readonly id = 'vscToolbox.getFileName';
    public readonly title = 'VSC Toolbox: Copy File Name';

    constructor(private context: vscode.ExtensionContext) {}

    async execute(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        
        if (!editor) {
            vscode.window.showWarningMessage('No active file open');
            return;
        }

        const fileName = path.basename(editor.document.uri.fsPath);
        
        await vscode.env.clipboard.writeText(fileName);
        vscode.window.showInformationMessage(`Copied to clipboard: ${fileName}`);
    }
}
