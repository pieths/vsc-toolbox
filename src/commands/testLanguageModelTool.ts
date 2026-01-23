// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import { TOOL_REGISTRY } from '../tools/index';
import { getFileSearchToolInstance } from '../tools/search';

/**
 * Generic test command for all language model tools
 * Allows manual testing from the command palette
 */
export class TestLanguageModelToolCommand {
    public readonly id = 'vscToolbox.testLanguageModelTool';

    constructor(private context: vscode.ExtensionContext) { }

    async execute(): Promise<void> {
        // Let user select which tool to test
        const toolOptions = TOOL_REGISTRY.map(entry => ({
            label: entry.name,
            description: `Test ${entry.name}`,
            toolEntry: entry
        }));

        const selectedTool = await vscode.window.showQuickPick(toolOptions, {
            placeHolder: 'Select a tool to test',
        });

        if (!selectedTool) {
            return;
        }

        // Get input parameters based on the tool
        const input = await this.getInputForTool(selectedTool.label);
        if (!input) {
            return;
        }

        // Create tool instance and invoke it
        let tool: vscode.LanguageModelTool<any>;

        if (selectedTool.label === 'fileSearch') {
            // fileSearch is a special case - use the existing instance
            // to avoid costly re-initialization
            const fileSearchTool = getFileSearchToolInstance();
            if (!fileSearchTool) {
                vscode.window.showErrorMessage('File search tool is not initialized yet');
                return;
            }
            tool = fileSearchTool;
        } else {
            const ToolClass = selectedTool.toolEntry.class;
            tool = new ToolClass(this.context);
        }

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Executing ${selectedTool.label}...`,
                    cancellable: true,
                },
                async (progress, token) => {
                    const result = await tool.invoke(
                        {
                            input,
                            toolInvocationToken: undefined as any
                        },
                        token
                    );

                    if (!result) {
                        vscode.window.showWarningMessage('Tool returned no result');
                        return;
                    }

                    // Display results in a new document
                    const doc = await vscode.workspace.openTextDocument({
                        content: result.content.map(c =>
                            c instanceof vscode.LanguageModelTextPart ? c.value : ''
                        ).join('\n'),
                        language: 'markdown',
                    });

                    await vscode.window.showTextDocument(doc);
                }
            );
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error: ${error.message}`);
        }
    }

    /**
     * Get input parameters for a specific tool
     */
    private async getInputForTool(toolName: string): Promise<any | undefined> {
        switch (toolName) {
            case 'getWorkspaceSymbol':
                return this.getWorkspaceSymbolInput();

            case 'getDocumentSymbolReferences':
                return this.getTextDocumentReferencesInput();

            case 'fileSearch':
                return this.getFileSearchInput();

            default:
                vscode.window.showErrorMessage(`No input handler for tool: ${toolName}`);
                return undefined;
        }
    }

    /**
     * Get input for getWorkspaceSymbol tool
     */
    private async getWorkspaceSymbolInput(): Promise<any | undefined> {
        const query = await vscode.window.showInputBox({
            prompt: 'Enter symbol name to search for',
            placeHolder: 'e.g., MyClass, myFunction, etc.',
        });

        if (!query) {
            return undefined;
        }

        const useFilter = await vscode.window.showQuickPick(['No', 'Yes'], {
            placeHolder: 'Do you want to filter results by path?',
        });

        let filter: string[] | undefined;
        if (useFilter === 'Yes') {
            const filterInput = await vscode.window.showInputBox({
                prompt: 'Enter path patterns to filter (comma-separated)',
                placeHolder: 'e.g., src/tools, src/commands',
            });

            if (filterInput) {
                filter = filterInput.split(',').map(s => s.trim());
            }
        }

        return { query, filter };
    }

    /**
     * Get input for getDocumentSymbolReferences tool
     */
    private async getTextDocumentReferencesInput(): Promise<any | undefined> {
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
            vscode.window.showWarningMessage('No active editor. Please open a file and position the cursor on a symbol.');
            return undefined;
        }

        const position = editor.selection.active;
        const document = editor.document;

        // Get the word at the cursor position (the symbol name)
        const wordRange = document.getWordRangeAtPosition(position);
        const symbolName = wordRange ? document.getText(wordRange) : '';

        // Get the source line
        const sourceLine = document.lineAt(position.line).text;

        return {
            uri: document.uri.toString(),
            position: {
                line: position.line,
                character: position.character,
            },
            symbolName,
            sourceLine,
        };
    }

    /**
     * Get input for fileSearch tool
     */
    private async getFileSearchInput(): Promise<any | undefined> {
        const query = await vscode.window.showInputBox({
            prompt: 'Enter search query (space-separated terms are OR\'d, supports * and ? globs)',
            placeHolder: 'e.g., options*input partSymbols, get?Name',
        });

        if (!query) {
            return undefined;
        }

        return { query };
    }
}
