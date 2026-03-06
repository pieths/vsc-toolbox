// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import { GetFileNameCommand } from './getFileName';
import { SearchRemoteCodeCommand } from './searchRemoteCode';
import { GetWinDbgBreakpointLocationCommand } from './getWinDbgBreakpointLocation';
import { GetGnTargetsForFileCommand } from './getGnTargetsForFile';
import { TestLanguageModelToolCommand } from './testLanguageModelTool';
import { FilterLinesByPatternCommand } from './filterLinesByPattern';
import { OpenFileUnderCursorCommand } from './openFileUnderCursor';

/**
 * Command registry - add new commands here to automatically register them
 */
export const COMMAND_REGISTRY = [
    GetFileNameCommand,
    SearchRemoteCodeCommand,
    GetWinDbgBreakpointLocationCommand,
    GetGnTargetsForFileCommand,
    TestLanguageModelToolCommand,
    FilterLinesByPatternCommand,
    OpenFileUnderCursorCommand,
] as const;
