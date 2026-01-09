// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';

/**
 * Filter Lines By Pattern Command - Filters lines in current file by glob patterns
 */
export class FilterLinesByPatternCommand {
    public readonly id = 'vscToolbox.filterLinesByPattern';
    public readonly title = 'VSC Toolbox: Filter Lines By Pattern';

    private static readonly STORAGE_KEY = 'filterLinesByPattern.patterns';

    constructor(private context: vscode.ExtensionContext) { }

    async execute(): Promise<void> {
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
            vscode.window.showWarningMessage('No active editor');
            return;
        }

        // Prompt user for patterns
        const selectedPatterns = await this.promptForPatterns();

        if (!selectedPatterns || selectedPatterns.length === 0) {
            return; // User cancelled or no patterns selected
        }

        // Filter lines directly from the document without copying all lines
        const document = editor.document;
        const lineCount = document.lineCount;
        const filteredLines: string[] = [];

        for (let i = 0; i < lineCount; i++) {
            const lineText = document.lineAt(i).text;
            if (selectedPatterns.some(pattern => this.matchesPattern(lineText, pattern))) {
                filteredLines.push(lineText);
            }
        }

        if (filteredLines.length === 0) {
            vscode.window.showInformationMessage('No lines matched the selected patterns');
            return;
        }

        // Create a new untitled document with the filtered lines
        const content = filteredLines.join('\n');
        const newDocument = await vscode.workspace.openTextDocument({
            content,
            language: document.languageId
        });

        await vscode.window.showTextDocument(newDocument, { preview: false });

        vscode.window.showInformationMessage(
            `Filtered ${filteredLines.length} lines from ${lineCount} total lines`
        );
    }

    /**
     * Prompts the user to select/add glob patterns with multi-select support
     */
    private async promptForPatterns(): Promise<string[] | undefined> {
        return new Promise((resolve) => {
            // Load previously saved patterns from workspace state
            let savedPatterns: string[] = this.context.workspaceState.get(
                FilterLinesByPatternCommand.STORAGE_KEY,
                []
            );

            const quickPick = vscode.window.createQuickPick();
            quickPick.canSelectMany = true;
            quickPick.placeholder = 'Type a glob pattern and click + to add, or select from history. Press Enter to apply.';
            quickPick.title = 'Filter Lines By Pattern';

            const addButton: vscode.QuickInputButton = {
                iconPath: new vscode.ThemeIcon('add'),
                tooltip: 'Add pattern'
            };
            const deleteButton: vscode.QuickInputButton = {
                iconPath: new vscode.ThemeIcon('trash'),
                tooltip: 'Remove from history'
            };
            quickPick.buttons = [addButton];

            const refreshItems = () => {
                const currentSelected = new Set(quickPick.selectedItems.map(i => i.label));
                quickPick.items = savedPatterns.map(label => ({
                    label,
                    buttons: [deleteButton]
                }));
                // Restore selection after refresh
                quickPick.selectedItems = quickPick.items.filter(i => currentSelected.has(i.label));
            };

            quickPick.onDidTriggerButton((button) => {
                if (button === addButton && quickPick.value.trim()) {
                    const newPattern = quickPick.value.trim();
                    if (!savedPatterns.includes(newPattern)) {
                        savedPatterns.push(newPattern);
                        this.context.workspaceState.update(
                            FilterLinesByPatternCommand.STORAGE_KEY,
                            savedPatterns
                        );
                    }
                    const previouslySelected = quickPick.selectedItems.map(i => i.label);
                    refreshItems();
                    // Auto-select the new pattern plus previous selections
                    quickPick.selectedItems = quickPick.items.filter(
                        i => i.label === newPattern || previouslySelected.includes(i.label)
                    );
                    quickPick.value = '';
                }
            });

            quickPick.onDidTriggerItemButton((e) => {
                savedPatterns = savedPatterns.filter(item => item !== e.item.label);
                this.context.workspaceState.update(
                    FilterLinesByPatternCommand.STORAGE_KEY,
                    savedPatterns
                );
                refreshItems();
            });

            quickPick.onDidAccept(() => {
                const result = quickPick.selectedItems.map(item => item.label);

                // Also include the typed text as a pattern if present
                const typedValue = quickPick.value.trim();
                if (typedValue && !result.includes(typedValue)) {
                    result.push(typedValue);

                    // Add to saved patterns for future use
                    if (!savedPatterns.includes(typedValue)) {
                        savedPatterns.push(typedValue);
                        this.context.workspaceState.update(
                            FilterLinesByPatternCommand.STORAGE_KEY,
                            savedPatterns
                        );
                    }
                }

                quickPick.hide();
                resolve(result);
            });

            quickPick.onDidHide(() => {
                quickPick.dispose();
                resolve(undefined);
            });

            refreshItems();
            quickPick.show();
        });
    }

    /**
     * Converts a glob pattern to a case insensitive regular expression.
     * Supports * (matches any characters) and ? (matches single character)
     */
    private globToRegex(pattern: string): RegExp {
        // Escape special regex characters except * and ?
        let regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        // Convert glob wildcards to regex
        regexStr = regexStr.replace(/\*/g, '.*');
        regexStr = regexStr.replace(/\?/g, '.');
        return new RegExp(regexStr, 'i');
    }

    /**
     * Checks if a line matches the given glob pattern
     */
    private matchesPattern(line: string, pattern: string): boolean {
        try {
            const regex = this.globToRegex(pattern);
            return regex.test(line);
        } catch {
            return false;
        }
    }
}
