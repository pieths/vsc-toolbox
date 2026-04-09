// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import { TOOL_REGISTRY } from './tools/index';
import { COMMAND_REGISTRY } from './commands/index';
import { configureLogger, log } from './common/logger';
import { initializeCopilotUtils } from './common/languageModelUtils';
import { ContentIndex } from './common/index';

// ── Logger initialization ─────────────────────────────────────────────

const enum LogLevel {
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
}

const LOG_LEVEL_MAP: Record<string, LogLevel> = {
    debug: LogLevel.Debug,
    info: LogLevel.Info,
    warn: LogLevel.Warn,
    error: LogLevel.Error,
};

/**
 * Initialize the shared logger for the extension host.
 * Creates a vscode OutputChannel and wires the logging functions.
 */
function initLogger(context: vscode.ExtensionContext): void {
    const outputChannel = vscode.window.createOutputChannel('VSC Toolbox');
    context.subscriptions.push(outputChannel);

    let currentLevel: LogLevel = LogLevel.Info;

    function updateLogLevel(): void {
        const config = vscode.workspace.getConfiguration('vscToolbox');
        const level = config.get<string>('logLevel', 'info');
        currentLevel = LOG_LEVEL_MAP[level] ?? LogLevel.Info;
    }

    updateLogLevel();

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('vscToolbox.logLevel')) {
                updateLogLevel();
            }
        })
    );

    function getTimestamp(): string {
        return new Date().toLocaleTimeString('en-US', { hour12: false });
    }

    configureLogger({
        debug: (message: string) => {
            if (currentLevel <= LogLevel.Debug) {
                outputChannel.appendLine(`[${getTimestamp()}] [DEBUG] ${message}`);
            }
        },
        log: (message: string) => {
            if (currentLevel <= LogLevel.Info) {
                outputChannel.appendLine(`[${getTimestamp()}] [INFO] ${message}`);
            }
        },
        warn: (message: string) => {
            if (currentLevel <= LogLevel.Warn) {
                outputChannel.appendLine(`[${getTimestamp()}] [WARN] ${message}`);
            }
        },
        error: (message: string) => {
            if (currentLevel <= LogLevel.Error) {
                outputChannel.appendLine(`[${getTimestamp()}] [ERROR] ${message}`);
            }
        },
    });
}

// ── Extension lifecycle ───────────────────────────────────────────────

/**
 * Extension activation
 */
export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  // Initialize the shared logger first
  initLogger(context);
  log('VSC Toolbox extension is activating...');

  initializeCopilotUtils(context);

  try {
    ContentIndex.getInstance().initialize(context);
    log('ContentIndex initialized');

    // Register all language model tools from the registry
    for (const { name, class: ToolClass } of TOOL_REGISTRY) {
      const tool = new ToolClass(context);
      const disposable = vscode.lm.registerTool(name, tool);
      context.subscriptions.push(disposable);
      log(`Registered tool: ${name}`);
    }

    // Register all commands from the registry
    for (const CommandClass of COMMAND_REGISTRY) {
      const command = new CommandClass(context);
      const disposable = vscode.commands.registerCommand(
        command.id,
        () => command.execute()
      );
      context.subscriptions.push(disposable);
      log(`Registered command: ${command.id}`);
    }

    log('VSC Toolbox registered successfully');
  } catch (error) {
    vscode.window.showErrorMessage(
      `VSC Toolbox failed to activate: ${error}`
    );
    log(`Activation error: ${error}`);
  }
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  log('VSC Toolbox extension is deactivating...');
}
