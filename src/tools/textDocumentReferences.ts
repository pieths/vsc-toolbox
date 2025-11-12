// Copyright (c) 2025 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';

/**
 * Input parameters for finding references
 */
export interface ITextDocumentReferencesParams {
    uri: string;
    position: {
        line: number;
        character: number;
    };
}

/**
 * Text Document References Tool - Find all references to a symbol
 * Uses VS Code's built-in reference provider
 */
export class TextDocumentReferencesTool implements vscode.LanguageModelTool<ITextDocumentReferencesParams> {
    constructor() { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ITextDocumentReferencesParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { uri, position } = options.input;
        const fileName = uri.split('/').pop() || uri;

        return {
            invocationMessage: `Finding references at ${fileName}:${position.line + 1}:${position.character + 1}`,
            confirmationMessages: {
                title: 'Find References',
                message: new vscode.MarkdownString(
                    `Find all references to the symbol at:\n\n` +
                    `- **File**: \`${fileName}\`\n` +
                    `- **Line**: ${position.line + 1}\n` +
                    `- **Column**: ${position.character + 1}`
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ITextDocumentReferencesParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { uri, position } = options.input;

        try {
            // Parse the URI
            const parsedUri = vscode.Uri.parse(uri);

            // Open the document (VS Code will handle this internally)
            const document = await vscode.workspace.openTextDocument(parsedUri);
            const vscodePosition = new vscode.Position(position.line, position.character);

            // Use VS Code's built-in command which handles language server communication
            // This works even for files that aren't open because VS Code manages it
            const references = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeReferenceProvider',
                document.uri,
                vscodePosition
            );

            if (!references) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(JSON.stringify({
                        uri,
                        position,
                        totalReferences: 0,
                        references: []
                    }, null, 2)),
                ]);
            }

            const result = {
                uri,
                position,
                totalReferences: references.length,
                references: references.map((ref) => ({
                    uri: ref.uri.toString(),
                    range: {
                        start: {
                            line: ref.range.start.line,
                            character: ref.range.start.character,
                        },
                        end: {
                            line: ref.range.end.line,
                            character: ref.range.end.character,
                        },
                    },
                })),
            };

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
            ]);
        } catch (error: any) {
            throw new Error(`Failed to find references: ${error.message}. Verify the file URI and position are correct.`);
        }
    }
}
