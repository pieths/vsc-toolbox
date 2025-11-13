// Copyright (c) 2025 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import { GetFileNameCommand } from './getFileName';
import { SearchRemoteCodeCommand } from './searchRemoteCode';
import { GetWinDbgBreakpointLocationCommand } from './getWinDbgBreakpointLocation';
import { GetGnTargetsForFileCommand } from './getGnTargetsForFile';

/**
 * Command registry - add new commands here to automatically register them
 */
export const COMMAND_REGISTRY = [
    GetFileNameCommand,
    SearchRemoteCodeCommand,
    GetWinDbgBreakpointLocationCommand,
    GetGnTargetsForFileCommand,
] as const;
