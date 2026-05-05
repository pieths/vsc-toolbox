// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Barrel exports for the parser subsystem.
 */

export { SymbolType, AttrKey, symbolTypeToString, CALLABLE_TYPES, CONTAINER_TYPES } from './types';
export type { IndexFile, IndexSymbol, IFileParser } from './types';
export { getParserForExtension, getParserForFile, getAllParsers } from './registry';
