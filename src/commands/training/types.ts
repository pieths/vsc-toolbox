// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/** A chunk reference using line numbers */
export interface ChunkRef {
    /** Absolute file path */
    filePath: string;
    /** 1-based start line (inclusive) */
    startLine: number;
    /** 1-based end line (inclusive) */
    endLine: number;
}

/** A training sample with content resolved from the actual file */
export interface ResolvedTrainingSample {
    query: string;
    queryType: string;
    positive: ChunkRef;
    hardNegatives: ChunkRef[];
    easyNegatives: ChunkRef[];
}
