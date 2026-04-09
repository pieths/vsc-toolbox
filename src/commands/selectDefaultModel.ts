// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import { getAvailableModels } from '../common/languageModelUtils';

/**
 * Select Default Model Command - Shows a quick pick of available language models
 * and saves the selected model ID to the vscToolbox.defaultModelId setting.
 */
export class SelectDefaultModelCommand {
    public readonly id = 'vscToolbox.selectDefaultModel';
    public readonly title = 'VSC Toolbox: Select Default Language Model';

    constructor(private context: vscode.ExtensionContext) { }

    async execute(): Promise<void> {
        const models = await getAvailableModels();

        if (models.length === 0) {
            vscode.window.showWarningMessage('No language models available');
            return;
        }

        const config = vscode.workspace.getConfiguration('vscToolbox');
        const currentId = config.get<string>('defaultModelId', '');

        const items: vscode.QuickPickItem[] = models.map(model => ({
            label: model.name,
            description: model.id,
            detail: `Family: ${model.family}`,
            picked: model.id === currentId,
        }));

        const selected = await vscode.window.showQuickPick(items, {
            title: 'Select Default Language Model',
            placeHolder: currentId ? `Current: ${currentId}` : 'Choose a model',
        });

        if (!selected || !selected.description) {
            return;
        }

        await config.update('defaultModelId', selected.description, vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage(`VSC Toolbox: Default model set to "${selected.description}"`);
    }
}
