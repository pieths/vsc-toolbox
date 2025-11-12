// Copyright (c) 2025 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';

/**
 * Search Remote Code Command - Opens code search with selected text
 */
export class SearchRemoteCodeCommand {
    public readonly id = 'vscToolbox.searchRemoteCode';
    public readonly title = 'VSC Toolbox: Search Remote Code';

    constructor(private context: vscode.ExtensionContext) { }

    async execute(): Promise<void> {
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
            vscode.window.showWarningMessage('No active editor');
            return;
        }

        let searchText = editor.document.getText(editor.selection);

        // If no selection, get the word under the cursor
        if (!searchText) {
            const position = editor.selection.active;
            const wordRange = editor.document.getWordRangeAtPosition(position);

            if (wordRange) {
                searchText = editor.document.getText(wordRange);
            }
        }

        if (!searchText) {
            vscode.window.showWarningMessage('No text selected or word under cursor');
            return;
        }

        // Get the configured search URLs
        const config = vscode.workspace.getConfiguration('vscToolbox');
        const searchUrls = config.get<Array<{ name: string; url: string }>>('searchUrls', [
            { name: 'Chromium Source', url: 'https://source.chromium.org/search?q="{query}"' }
        ]);

        if (searchUrls.length === 0) {
            vscode.window.showErrorMessage('No search URLs configured in VSC Toolbox settings');
            return;
        }

        // If multiple options, let user choose
        let selectedUrl: string;
        let selectedName: string;

        if (searchUrls.length === 1) {
            selectedUrl = searchUrls[0].url;
            selectedName = searchUrls[0].name;
        } else {
            // Get last used search engine name
            const lastUsedName = this.context.workspaceState.get<string>('lastSearchUrlName');

            // Sort URLs with last used at the top
            const sortedUrls = lastUsedName
                ? [
                    ...searchUrls.filter(u => u.name === lastUsedName),
                    ...searchUrls.filter(u => u.name !== lastUsedName)
                ]
                : searchUrls;

            const selected = await vscode.window.showQuickPick(
                sortedUrls.map(item => ({ label: item.name, url: item.url })),
                { placeHolder: 'Select a code search engine' }
            );

            if (!selected) {
                return; // User cancelled
            }
            selectedUrl = selected.url;
            selectedName = selected.label;

            // Save the selection for next time
            await this.context.workspaceState.update('lastSearchUrlName', selectedName);
        }

        // URL encode the search text and replace placeholder
        const encodedQuery = encodeURIComponent(searchText);
        const url = selectedUrl.replace('{query}', encodedQuery);

        // Open in external browser
        await vscode.env.openExternal(vscode.Uri.parse(url));
        vscode.window.showInformationMessage(`Searching for: ${searchText}`);
    }
}
