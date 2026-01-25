// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * File Index module - provides file indexing and search functionality.
 *
 * This module exports only the public interface. Implementation details
 * (CacheManager, ThreadPool, FileWatcher, etc.) are hidden.
 */

export { ContentIndex } from './contentIndex';
export { SearchResult, SearchResults } from './types';
