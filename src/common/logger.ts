// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';

/**
 * Shared logger for the VSC Toolbox extension.
 * Outputs to a dedicated Output Channel visible in VS Code's Output panel.
 */

let outputChannel: vscode.OutputChannel | null = null;

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

let currentLevel: LogLevel = LogLevel.Info;

/**
 * Read the configured log level from settings and update the current level.
 */
function updateLogLevel(): void {
    const config = vscode.workspace.getConfiguration('vscToolbox');
    const level = config.get<string>('logLevel', 'info');
    currentLevel = LOG_LEVEL_MAP[level] ?? LogLevel.Info;
}

/**
 * Initialize the logger. Must be called once during extension activation.
 *
 * @param context - Extension context for registering disposables
 */
export function initLogger(context: vscode.ExtensionContext): void {
    outputChannel = vscode.window.createOutputChannel('VSC Toolbox');
    context.subscriptions.push(outputChannel);

    updateLogLevel();

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('vscToolbox.logLevel')) {
                updateLogLevel();
            }
        })
    );
}

/**
 * Get the current timestamp in HH:MM:SS format.
 */
function getTimestamp(): string {
    const now = new Date();
    return now.toLocaleTimeString('en-US', { hour12: false });
}

/**
 * Log a debug message.
 *
 * @param message - Message to log
 */
export function debug(message: string): void {
    if (outputChannel && currentLevel <= LogLevel.Debug) {
        outputChannel.appendLine(`[${getTimestamp()}] [DEBUG] ${message}`);
    }
}

/**
 * Log an informational message.
 *
 * @param message - Message to log
 */
export function log(message: string): void {
    if (outputChannel && currentLevel <= LogLevel.Info) {
        outputChannel.appendLine(`[${getTimestamp()}] [INFO] ${message}`);
    }
}

/**
 * Log a warning message.
 *
 * @param message - Message to log
 */
export function warn(message: string): void {
    if (outputChannel && currentLevel <= LogLevel.Warn) {
        outputChannel.appendLine(`[${getTimestamp()}] [WARN] ${message}`);
    }
}

/**
 * Log an error message.
 *
 * @param message - Message to log
 */
export function error(message: string): void {
    if (outputChannel && currentLevel <= LogLevel.Error) {
        outputChannel.appendLine(`[${getTimestamp()}] [ERROR] ${message}`);
    }
}

/**
 * Show the output channel in the Output panel.
 */
export function show(): void {
    if (outputChannel) {
        outputChannel.show();
    }
}

/**
 * Clear the output channel.
 */
export function clear(): void {
    if (outputChannel) {
        outputChannel.clear();
    }
}
