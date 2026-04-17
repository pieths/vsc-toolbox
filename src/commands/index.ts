// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import { GetFileNameCommand } from './getFileName';
import { SearchRemoteCodeCommand } from './searchRemoteCode';
import { GetWinDbgBreakpointLocationCommand } from './getWinDbgBreakpointLocation';
import { GetGnTargetsForFileCommand } from './getGnTargetsForFile';
import { TestLanguageModelToolCommand } from './testLanguageModelTool';
import { FilterLinesByPatternCommand } from './filterLinesByPattern';
import { OpenFileUnderCursorCommand } from './openFileUnderCursor';
import { SelectDefaultModelCommand } from './selectDefaultModel';
import { GeneratePerFileEmbeddingTrainingDataCommand } from './training/generatePerFileEmbeddingTrainingData';
import { OpenPerFileEmbeddingTrainingDataCommand } from './training/openPerFileEmbeddingTrainingData';
import { UpdatePerFileEmbeddingTrainingDataEasyNegativesCommand } from './training/updatePerFileEmbeddingTrainingDataEasyNegatives';

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
    SelectDefaultModelCommand,
    GeneratePerFileEmbeddingTrainingDataCommand,
    OpenPerFileEmbeddingTrainingDataCommand,
    UpdatePerFileEmbeddingTrainingDataEasyNegativesCommand,
] as const;
