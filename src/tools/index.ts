// Copyright (c) 2025 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import { GetWorkspaceSymbolTool } from './getWorkspaceSymbol';
import { GetDocumentSymbolReferencesTool } from './getDocumentSymbolReferences';

/**
 * Tool registry - add new tools here to automatically register them
 */
export const TOOL_REGISTRY = [
    { name: 'getWorkspaceSymbol', class: GetWorkspaceSymbolTool },
    { name: 'getDocumentSymbolReferences', class: GetDocumentSymbolReferencesTool },
] as const;
