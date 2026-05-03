// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import type { IndexSymbol, MutableAttrMap } from '../types';

export function hydrateSymbols(symbols: unknown[][]): IndexSymbol[] {
    return symbols.map(sym => {
        const nums = sym[0] as number[];
        const strings = (sym[1] as string[] | undefined) ?? [];
        const [type, startLine, startCol, endLine, endCol,
            nameStartLine, nameStartCol, nameEndLine, nameEndCol] = nums;

        const attrs = new Map() as MutableAttrMap;

        return {
            type,
            name: strings[0] ?? '',
            startLine,
            startColumn: startCol,
            endLine,
            endColumn: endCol,
            nameStartLine,
            nameStartColumn: nameStartCol,
            nameEndLine,
            nameEndColumn: nameEndCol,
            attrs,
        };
    });
};
