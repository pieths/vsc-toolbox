// Copyright (c) 2025 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import { WorkspaceSymbolTool } from './workspaceSymbol';
import { TextDocumentReferencesTool } from './textDocumentReferences';

/**
 * Tool registry - add new tools here to automatically register them
 */
export const TOOL_REGISTRY = [
    { name: 'workspace_symbol', class: WorkspaceSymbolTool },
    { name: 'textDocument_references', class: TextDocumentReferencesTool },
] as const;
