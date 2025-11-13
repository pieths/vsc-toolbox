// Copyright (c) 2025 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const readdirAsync = promisify(fs.readdir);
const statAsync = promisify(fs.stat);

/**
 * Get GN Targets For File Command - Determines which GN targets a source file belongs to
 */
export class GetGnTargetsForFileCommand {
    public readonly id = 'vscToolbox.getGnTargetsForFile';
    public readonly title = 'VSC Toolbox: Get GN Targets For File';

    constructor(private context: vscode.ExtensionContext) { }

    async execute(): Promise<void> {
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
            vscode.window.showWarningMessage('No active file open');
            return;
        }

        const document = editor.document;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

        if (!workspaceFolder) {
            vscode.window.showWarningMessage('File is not in a workspace folder');
            return;
        }

        const workspacePath = workspaceFolder.uri.fsPath;

        // Get available output directories from the 'out' folder
        const selectedOutDir = await this.selectOutputDirectory(workspacePath);
        if (!selectedOutDir) {
            return; // User cancelled or error occurred
        }

        // Prompt user to select target type
        const selectedType = await this.selectTargetType();
        if (!selectedType) {
            return; // User cancelled
        }

        const relativePath = path.relative(workspacePath, document.uri.fsPath);

        // Convert to forward slashes for gn command
        const gnPath = relativePath.replace(/\\/g, '/');

        try {
            // Show progress indicator
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Finding ${selectedType} targets...`,
                cancellable: false
            }, async () => {
                // Run the gn refs command with selected output directory
                const command = `gn refs out\\${selectedOutDir} ${gnPath} --all --type=${selectedType} --as=output`;

                const { stdout, stderr } = await execAsync(command, {
                    cwd: workspacePath,
                    shell: 'powershell.exe'
                });

                if (stderr) {
                    console.error('gn refs stderr:', stderr);
                }

                const output = stdout.trim();

                if (!output) {
                    vscode.window.showInformationMessage(`No ${selectedType} targets found for this file`);
                    return;
                }

                // Parse the output - typically shows executable paths like "out/release_x64/chrome.exe"
                const lines = output.split('\n').map(line => line.trim()).filter(line => line);

                // Sort lines for display
                const sortedLines = lines.sort();

                // Prepare result content
                const resultContent = [
                    `GN Refs Results - ${selectedType} targets for: ${gnPath}`,
                    `Command: ${command}`,
                    `Found ${lines.length} target${lines.length === 1 ? '' : 's'}:`,
                    '',
                    ...sortedLines
                ].join('\n');

                // Open text document with results
                const doc = await vscode.workspace.openTextDocument({
                    content: resultContent,
                    language: 'plaintext'
                });

                await vscode.window.showTextDocument(doc);

                // Copy to clipboard if single target
                if (lines.length === 1) {
                    const targetName = path.basename(lines[0]);
                    await vscode.env.clipboard.writeText(targetName);
                    vscode.window.showInformationMessage(`Target: ${targetName} (copied to clipboard)`);
                } else {
                    vscode.window.showInformationMessage(`Found ${lines.length} ${selectedType} targets`);
                }
            });
        } catch (error: any) {
            const errorMessage = error.message || String(error);
            vscode.window.showErrorMessage(`Failed to determine executable: ${errorMessage}`);
            console.error('Error running gn refs:', error);
        }
    }

    private async selectOutputDirectory(workspacePath: string): Promise<string | undefined> {
        const outPath = path.join(workspacePath, 'out');
        let outDirs: string[] = [];

        try {
            const entries = await readdirAsync(outPath);
            const dirChecks = await Promise.all(
                entries.map(async entry => {
                    const fullPath = path.join(outPath, entry);
                    const stat = await statAsync(fullPath);
                    return { entry, isDir: stat.isDirectory() };
                })
            );
            outDirs = dirChecks.filter(item => item.isDir).map(item => item.entry);
        } catch (error) {
            vscode.window.showErrorMessage('Could not read output directories from "out" folder');
            console.error('Error reading out directory:', error);
            return undefined;
        }

        if (outDirs.length === 0) {
            vscode.window.showWarningMessage('No output directories found in "out" folder');
            return undefined;
        }

        // Get last selected directory from context
        const lastSelectedDir = this.context.workspaceState.get<string>('lastSelectedOutDir');

        // If last selected directory exists in current list, move it to the front
        if (lastSelectedDir && outDirs.includes(lastSelectedDir)) {
            outDirs = [lastSelectedDir, ...outDirs.filter(dir => dir !== lastSelectedDir)];
        }

        // Prompt user to select output directory
        const selected = await vscode.window.showQuickPick(outDirs, {
            placeHolder: 'Select output directory'
        });

        // Save the selected directory for next time
        if (selected) {
            await this.context.workspaceState.update('lastSelectedOutDir', selected);
        }

        return selected;
    }

    private async selectTargetType(): Promise<string | undefined> {
        const targetTypes = [
            'executable',
            'shared_library',
            'loadable_module',
            'static_library',
            'source_set',
            'action',
            'copy',
            'group'
        ];

        return await vscode.window.showQuickPick(targetTypes, {
            placeHolder: 'Select target type to search for'
        });
    }
}
