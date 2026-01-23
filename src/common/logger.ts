// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';

/**
 * Shared logger for the VSC Toolbox extension.
 * Outputs to a dedicated Output Channel visible in VS Code's Output panel.
 */

let outputChannel: vscode.OutputChannel | null = null;

/**
 * Initialize the logger. Must be called once during extension activation.
 *
 * @param context - Extension context for registering disposables
 */
export function initLogger(context: vscode.ExtensionContext): void {
    outputChannel = vscode.window.createOutputChannel('VSC Toolbox');
    context.subscriptions.push(outputChannel);
}

/**
 * Get the current timestamp in HH:MM:SS format.
 */
function getTimestamp(): string {
    const now = new Date();
    return now.toLocaleTimeString('en-US', { hour12: false });
}

/**
 * Log an informational message.
 *
 * @param message - Message to log
 */
export function log(message: string): void {
    if (outputChannel) {
        outputChannel.appendLine(`[${getTimestamp()}] [INFO] ${message}`);
    }
}

/**
 * Log a warning message.
 *
 * @param message - Message to log
 */
export function warn(message: string): void {
    if (outputChannel) {
        outputChannel.appendLine(`[${getTimestamp()}] [WARN] ${message}`);
    }
}

/**
 * Log an error message.
 *
 * @param message - Message to log
 */
export function error(message: string): void {
    if (outputChannel) {
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
