// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import { GetWorkspaceSymbolTool } from './getWorkspaceSymbol';
import { GetDocumentSymbolReferencesTool } from './getDocumentSymbolReferences';
import { SearchIndexTool } from './searchIndex';
import { SearchEmbeddingsTool } from './searchEmbeddings';
import { AddKnowledgeBaseDocumentTool } from './addKnowledgeBaseDocument';

/**
 * Tool class constructor type that accepts an ExtensionContext
 */
export type ToolClass = new (context: vscode.ExtensionContext) => vscode.LanguageModelTool<any>;

export interface ToolRegistryEntry {
    name: string;
    class: ToolClass;
}

/**
 * Tool registry - add new tools here to automatically register them
 */
export const TOOL_REGISTRY: ToolRegistryEntry[] = [
    { name: 'getWorkspaceSymbol', class: GetWorkspaceSymbolTool },
    { name: 'getDocumentSymbolReferences', class: GetDocumentSymbolReferencesTool },
    { name: 'searchIndex', class: SearchIndexTool },
    { name: 'searchEmbeddings', class: SearchEmbeddingsTool },
    { name: 'addKnowledgeBaseDocument', class: AddKnowledgeBaseDocumentTool },
];
