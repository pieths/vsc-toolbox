// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Content Index module - provides file indexing and search functionality.
 *
 * This module exports only the public interface. Implementation details
 * (CacheManager, ThreadPool, FileWatcher, etc.) are hidden.
 */

export { ContentIndex } from './contentIndex';
export {
    SearchResult,
    SearchResults,
    FileLineRef,
    NearestEmbeddingResult,
} from './types';
export { SymbolType, AttrKey, symbolTypeToString, CALLABLE_TYPES, CONTAINER_TYPES } from './parsers/types';
export type { IndexSymbol } from './parsers/types';
