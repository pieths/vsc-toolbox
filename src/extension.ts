// Copyright (c) 2025 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import { TOOL_REGISTRY } from './tools/index';
import { COMMAND_REGISTRY } from './commands/index';

/**
 * Extension activation
 */
export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  console.log('VSC Toolbox extension is activating...');

  // Check if enabled
  const config = vscode.workspace.getConfiguration('vscToolbox');
  if (!config.get<boolean>('enable', true)) {
    console.log('VSC Toolbox is disabled in settings');
    return;
  }

  try {
    // Register all language model tools from the registry
    for (const { name, class: ToolClass } of TOOL_REGISTRY) {
      const tool = new ToolClass() as vscode.LanguageModelTool<any>;
      const disposable = vscode.lm.registerTool(name, tool);
      context.subscriptions.push(disposable);
      console.log(`Registered tool: ${name}`);
    }

    // Register all commands from the registry
    for (const CommandClass of COMMAND_REGISTRY) {
      const command = new CommandClass(context);
      const disposable = vscode.commands.registerCommand(
        command.id,
        () => command.execute()
      );
      context.subscriptions.push(disposable);
      console.log(`Registered command: ${command.id}`);
    }

    console.log('VSC Toolbox registered successfully');
  } catch (error) {
    vscode.window.showErrorMessage(
      `VSC Toolbox failed to activate: ${error}`
    );
    console.error('Activation error:', error);
  }
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  console.log('VSC Toolbox extension is deactivating...');
}
