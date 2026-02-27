// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from '../common/logger';

/**
 * Input parameters for the AddKnowledgeBaseDocument language model tool
 */
interface AddKnowledgeBaseDocumentParams {
    /** The file name to save the document as */
    documentName: string;
    /** The markdown content of the document */
    content: string;
}

/** Configuration key for the knowledge base directory setting */
const KB_DIR_SETTING = 'vscToolbox.contentIndex.knowledgeBaseDirectory';

/**
 * Resolve the knowledge base directory from settings, prompting the user
 * to select one if it has not been configured yet.
 *
 * @returns The absolute path to the knowledge base directory, or undefined
 *          if the user cancelled the selection dialog.
 */
async function resolveKnowledgeBaseDirectory(): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration('vscToolbox.contentIndex');
    let dir = config.get<string>('knowledgeBaseDirectory', '').trim();

    if (dir) {
        return dir;
    }

    // Setting is not configured — ask the user to pick a folder
    const selection = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select Knowledge Base Directory',
        title: 'Choose a directory for storing knowledge base documents',
    });

    if (!selection || selection.length === 0) {
        return undefined;
    }

    dir = selection[0].fsPath;

    // Persist the chosen directory as a workspace-level setting
    await config.update(
        'knowledgeBaseDirectory',
        dir,
        vscode.ConfigurationTarget.Workspace
    );

    log(`Knowledge base directory set to: ${dir}`);
    return dir;
}

/**
 * Ensure the file name has a `.md` extension.
 * If the name already ends with `.md` (case-insensitive), return it as-is.
 */
function ensureMarkdownExtension(name: string): string {
    if (name.toLowerCase().endsWith('.md')) {
        return name;
    }
    return `${name}.md`;
}

/**
 * AddKnowledgeBaseDocumentTool is a VS Code Language Model Tool that allows
 * AI agents to add new markdown documents to the knowledge base.
 */
export class AddKnowledgeBaseDocumentTool
    implements vscode.LanguageModelTool<AddKnowledgeBaseDocumentParams>
{
    constructor(_context: vscode.ExtensionContext) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<AddKnowledgeBaseDocumentParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { documentName, content } = options.input;

        try {
            // 1. Resolve the knowledge base directory
            const kbDir = await resolveKnowledgeBaseDirectory();
            if (!kbDir) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        'Error: No knowledge base directory was selected. ' +
                        'Please configure the "vscToolbox.contentIndex.knowledgeBaseDirectory" ' +
                        'setting and try again.'
                    ),
                ]);
            }

            // 2. Create the directory if it does not exist
            if (!fs.existsSync(kbDir)) {
                fs.mkdirSync(kbDir, { recursive: true });
                log(`Created knowledge base directory: ${kbDir}`);
            }

            // 3. Normalise the file name
            const fileName = ensureMarkdownExtension(documentName.trim());
            const filePath = path.join(kbDir, fileName);

            // 4. Check for an existing document with the same name
            if (fs.existsSync(filePath)) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Error: A document with the name '${fileName}' already exists ` +
                        'in the knowledge base. Please use another name.'
                    ),
                ]);
            }

            // 5. Write the document
            fs.writeFileSync(filePath, content, 'utf8');
            log(`Knowledge base document saved: ${filePath}`);

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Successfully saved knowledge base document '${fileName}' to ${filePath}`
                ),
            ]);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Error saving knowledge base document: ${message}`
                ),
            ]);
        }
    }
}
