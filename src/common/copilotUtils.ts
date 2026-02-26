// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import { ScopedFileCache } from './scopedFileCache';
import { log } from './logger';
import { parseQueryAsOr } from './queryParser';
import { ContentIndex } from './index';
import { symbolTypeToString, AttrKey } from './index';

/**
 * Utility functions for sending text to a Copilot language model.
 *
 * Usage:
 * ```typescript
 * // With explicit model:
 * const model = await getModel();
 * if (model) {
 *     const result = await sendSingleRequest(model, 'Summarize this code: ...');
 * }
 * // Or use the cached default model by passing null:
 * const result = await sendSingleRequest(null, 'Summarize this code: ...');
 * const result2 = await sendRequestWithReadFileAccess(null, 'Analyze the code in src/main.ts');
 * ```
 */

/** Cached default language model instance (lazy-initialized on first use) */
let cachedDefaultModel: vscode.LanguageModelChat | undefined;

/**
 * Get the cached default language model, initializing it on first call.
 * Uses `getModel()` with no parameters (defaults to claude-sonnet-4.5).
 */
async function getDefaultModel(): Promise<vscode.LanguageModelChat> {
    if (!cachedDefaultModel) {
        cachedDefaultModel = await getModel();
        if (!cachedDefaultModel) {
            throw new Error('No default language model available');
        }
    }
    return cachedDefaultModel;
}

/**
 * Tool definition for reading file lines
 */
const READ_FILE_TOOL: vscode.LanguageModelChatTool = {
    name: 'readFileLines',
    description: 'Read lines from a file given its path and line range. Use this to examine file contents.',
    inputSchema: {
        type: 'object',
        properties: {
            filePath: {
                type: 'string',
                description: 'Absolute path of the file to read in URI file: format'
            },
            startLine: {
                type: 'number',
                description: 'Starting line number (1-based, inclusive)'
            },
            endLine: {
                type: 'number',
                description: 'Ending line number (1-based, inclusive)'
            }
        },
        required: ['filePath']
    }
};

/**
 * Tool definition for searching file lines by glob pattern
 */
const FILE_GLOB_TOOL: vscode.LanguageModelChatTool = {
    name: 'searchFileByGlob',
    description: 'Search lines in a file using glob patterns. Supports * (zero or more characters) and ? (single character) wildcards. Space-separated patterns are OR\'d together.',
    inputSchema: {
        type: 'object',
        properties: {
            filePath: {
                type: 'string',
                description: 'Absolute path of the file to search in URI file: format'
            },
            query: {
                type: 'string',
                description: 'One or more glob patterns (space-separated). Use * for zero or more chars, ? for single char.'
            }
        },
        required: ['filePath', 'query']
    }
};

/**
 * Tool definition for getting the container at a specific line
 */
const GET_CONTAINER_TOOL: vscode.LanguageModelChatTool = {
    name: 'getContainer',
    description: 'Get the innermost container (function, class, namespace, etc.) that contains a specific line in a file. Returns details about the container including its type, fully qualified name, and line range (1-based).',
    inputSchema: {
        type: 'object',
        properties: {
            filePath: {
                type: 'string',
                description: 'Absolute path of the file in URI file: format'
            },
            line: {
                type: 'number',
                description: 'Line number (1-based) to find the container for'
            }
        },
        required: ['filePath', 'line']
    }
};

/**
 * Execute the readFileLines tool using a scoped cache
 */
async function executeReadFileTool(
    input: {
        filePath: string;
        startLine?: number;
        endLine?: number;
    },
    cache: ScopedFileCache
): Promise<string> {
    try {
        // Normalize the file path - handle both URI format and regular paths
        let normalizedPath = input.filePath;
        if (input.filePath.startsWith('file://')) {
            // Parse as URI and get the file system path
            normalizedPath = vscode.Uri.parse(input.filePath).fsPath;
        }

        const lines = await cache.getLines(normalizedPath);
        const totalLines = lines.length;

        const start = (input.startLine ?? 1) - 1; // Convert to 0-based
        const end = Math.min(input.endLine ?? totalLines, totalLines);

        const content = lines.slice(start, end).join('\n');
        const header = `File: \`${input.filePath}\`. Lines ${start + 1} to ${end} (${totalLines} lines total):`;

        return `${header}\n${content}`;
    } catch (error: any) {
        log(`Error reading file "${input.filePath}": ${error.message}`);
        return `Error reading file: ${error.message}`;
    }
}

/**
 * Execute the searchFileByGlob tool using a scoped cache
 */
async function executeFileGlobTool(
    input: {
        filePath: string;
        query: string;
    },
    cache: ScopedFileCache
): Promise<string> {
    try {
        // Normalize the file path - handle both URI format and regular paths
        let normalizedPath = input.filePath;
        if (input.filePath.startsWith('file://')) {
            // Parse as URI and get the file system path
            normalizedPath = vscode.Uri.parse(input.filePath).fsPath;
        }

        const lines = await cache.getLines(normalizedPath);
        const pattern = parseQueryAsOr(input.query);

        if (!pattern) {
            return `Error: Empty query pattern`;
        }

        const regex = new RegExp(pattern, 'i'); // Case-insensitive matching
        const matchingLines: string[] = [];

        for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
                matchingLines.push(`${i + 1}: ${lines[i]}`);
            }
        }

        const header = `File: \`${input.filePath}\`. Glob pattern: \`${input.query}\`. Matches: ${matchingLines.length} of ${lines.length} lines:`;

        if (matchingLines.length === 0) {
            return `${header}\n(no matches found)`;
        }

        return `${header}\n${matchingLines.join('\n')}`;
    } catch (error: any) {
        log(`Error searching file "${input.filePath}" with pattern "${input.query}": ${error.message}`);
        return `Error searching file: ${error.message}`;
    }
}

/**
 * Execute the getContainer tool
 */
async function executeGetContainerTool(
    input: {
        filePath: string;
        line: number;
    }
): Promise<string> {
    try {
        // Normalize the file path - handle both URI format and regular paths
        let normalizedPath = input.filePath;
        if (input.filePath.startsWith('file://')) {
            // Parse as URI and get the file system path
            normalizedPath = vscode.Uri.parse(input.filePath).fsPath;
        }

        const contentIndex = ContentIndex.getInstance();
        // Tool API uses 1-based lines; getContainer expects 0-based
        const container = await contentIndex.getContainer(normalizedPath, input.line - 1);

        const header = `File: \`${input.filePath}\`. Line ${input.line}. Container:`;

        if (!container) {
            return `${header}\n(no container found at this line)`;
        }

        const fqn = container.attrs.get(AttrKey.FullyQualifiedName) ?? container.name;
        const details = [
            `Type: ${symbolTypeToString(container.type)}`,
            `Fully Qualified Name: ${fqn}`,
            `Start Line: ${container.startLine + 1}`,
            `End Line: ${container.endLine + 1}`
        ];

        return `${header}\n${details.join('\n')}`;
    } catch (error: any) {
        log(`Error getting container for "${input.filePath}" at line ${input.line}: ${error.message}`);
        return `Error getting container: ${error.message}`;
    }
}

/**
 * Log all available language models to the output channel.
 * Useful for discovering model family strings.
 */
export async function logAvailableModels(): Promise<void> {
    const models = await vscode.lm.selectChatModels({});
    log(`Available language models (${models.length}):`);
    for (const model of models) {
        log(`  - Family: "${model.family}", Name: "${model.name}", ID: "${model.id}"`);
    }
}

/**
 * Get all available model IDs for use in UI dropdowns.
 * Returns an array of objects with id, name, and family for each model.
 */
export async function getAvailableModels(): Promise<Array<{ id: string; name: string; family: string }>> {
    const models = await vscode.lm.selectChatModels({});
    return models.map(model => ({
        id: model.id,
        name: model.name,
        family: model.family
    }));
}

/**
 * Select a language model by ID.
 * Defaults to 'claude-sonnet-4.5' if no ID is specified.
 *
 * Potentially available model IDs (use these strings):
 *
 * OpenAI:
 *   - 'gpt-4o-mini', 'gpt-4o', 'gpt-4.1'
 *   - 'gpt-5-mini', 'gpt-5', 'gpt-5.1', 'gpt-5.2'
 *   - 'gpt-5-codex', 'gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.1-codex-max', 'gpt-5.2-codex'
 *
 * Anthropic:
 *   - 'claude-haiku-4.5' (fast/cheap)
 *   - 'claude-sonnet-4', 'claude-sonnet-4.5'
 *   - 'claude-opus-41', 'claude-opus-4.5' (premium)
 *
 * Google:
 *   - 'gemini-2.5-pro'
 *   - 'gemini-3-flash-preview' (fast/cheap), 'gemini-3-pro-preview'
 *
 * Special:
 *   - 'copilot-fast' (alias for gpt-4o-mini)
 *   - 'auto' (auto-select)
 *
 * @param id - The model ID to select (e.g., 'gpt-4o', 'claude-haiku-4.5')
 * @returns The selected language model, or undefined if none available
 */
export async function getModel(id?: string): Promise<vscode.LanguageModelChat | undefined> {
    const selector: vscode.LanguageModelChatSelector = id
        ? { id }
        : { id: 'claude-opus-4.6' };

    const models = await vscode.lm.selectChatModels(selector);
    return models.length > 0 ? models[0] : undefined;
}

/**
 * Send text to a language model and return the response.
 * No tools are available - pure text in/out.
 *
 * @param model - The language model to use, or null to use the cached default model
 * @param text - The text to send to the model
 * @param cancellationToken - Optional cancellation token
 * @returns The model's response as a string
 */
export async function sendSingleRequest(
    model: vscode.LanguageModelChat | null,
    text: string,
    cancellationToken?: vscode.CancellationToken
): Promise<string> {
    const resolvedModel = model ?? await getDefaultModel();

    const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(text)
    ];

    const token = cancellationToken ?? new vscode.CancellationTokenSource().token;

    const response = await resolvedModel.sendRequest(messages, {}, token);

    // Collect all text fragments from the response stream
    const fragments: string[] = [];
    for await (const fragment of response.text) {
        fragments.push(fragment);
    }

    return fragments.join('');
}

/**
 * Send text to a language model with file reading capability.
 * The model can use the readFileLines tool to read file contents.
 *
 * @param model - The language model to use, or null to use the cached default model
 * @param text - The text to send to the model
 * @param cancellationToken - Optional cancellation token
 * @param maxToolCalls - Maximum number of tool calls to allow (default: 1000)
 * @param fileCache - Optional file cache to reuse; if not provided, a new one is created
 * @returns The model's final response as a string
 */
export async function sendRequestWithReadFileAccess(
    model: vscode.LanguageModelChat | null,
    text: string,
    cancellationToken?: vscode.CancellationToken,
    maxToolCalls: number = 1000,
    fileCache?: ScopedFileCache
): Promise<string> {
    const resolvedModel = model ?? await getDefaultModel();

    const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(text)
    ];

    log(`sendRequestWithReadFileAccess: Using model "${resolvedModel.name}" (${resolvedModel.id})`);

    const token = cancellationToken ?? new vscode.CancellationTokenSource().token;
    const cache = fileCache ?? new ScopedFileCache();
    let toolCallCount = 0;

    while (toolCallCount < maxToolCalls) {
        const response = await resolvedModel.sendRequest(
            messages,
            { tools: [READ_FILE_TOOL, FILE_GLOB_TOOL, GET_CONTAINER_TOOL] },
            token
        );

        const fragments: string[] = [];
        const toolCalls: vscode.LanguageModelToolCallPart[] = [];

        // Collect response parts
        for await (const part of response.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                fragments.push(part.value);
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                toolCalls.push(part);
            }
        }

        // If no tool calls, we're done - return the text response
        if (toolCalls.length === 0) {
            return fragments.join('');
        }

        // Process tool calls
        // Add assistant message with the tool calls
        messages.push(vscode.LanguageModelChatMessage.Assistant(
            toolCalls.map(tc => new vscode.LanguageModelToolCallPart(tc.callId, tc.name, tc.input))
        ));

        // Execute each tool and add results
        const toolResults: vscode.LanguageModelToolResultPart[] = [];
        for (const toolCall of toolCalls) {
            toolCallCount++;
            if (toolCall.name === 'readFileLines') {
                const input = toolCall.input as { filePath: string; startLine?: number; endLine?: number };
                const lineRange = input.startLine
                    ? `lines ${input.startLine}-${input.endLine ?? 'end'}`
                    : 'all lines';
                log(`Agent requested file read: ${input.filePath} (${lineRange})`);
                const result = await executeReadFileTool(input, cache);
                toolResults.push(new vscode.LanguageModelToolResultPart(toolCall.callId, [
                    new vscode.LanguageModelTextPart(result)
                ]));
            } else if (toolCall.name === 'searchFileByGlob') {
                const input = toolCall.input as { filePath: string; query: string };
                log(`Agent requested glob search: ${input.filePath} (pattern: ${input.query})`);
                const result = await executeFileGlobTool(input, cache);
                toolResults.push(new vscode.LanguageModelToolResultPart(toolCall.callId, [
                    new vscode.LanguageModelTextPart(result)
                ]));
            } else if (toolCall.name === 'getContainer') {
                const input = toolCall.input as { filePath: string; line: number };
                log(`Agent requested container: ${input.filePath} (line: ${input.line})`);
                const result = await executeGetContainerTool(input);
                toolResults.push(new vscode.LanguageModelToolResultPart(toolCall.callId, [
                    new vscode.LanguageModelTextPart(result)
                ]));
            }
        }

        // Add tool results as a user message
        messages.push(vscode.LanguageModelChatMessage.User(toolResults));
    }

    return 'Maximum tool calls exceeded';
}
