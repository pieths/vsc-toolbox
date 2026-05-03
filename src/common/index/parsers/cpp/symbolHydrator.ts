// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import { SymbolType, AttrKey } from '../types';
import type { IndexSymbol, MutableAttrMap } from '../types';
import { NumsMarker, NUMS_MARKER_PAYLOAD } from './symbolExtractor';

export function hydrateSymbols(symbols: unknown[][]): IndexSymbol[] {
    return symbols.map(sym => {
        const nums = sym[0] as number[];
        const strings = (sym[1] as string[] | undefined) ?? [];
        const [type, startLine, startCol, endLine, endCol,
            nameStartLine, nameStartCol, nameEndLine, nameEndCol] = nums;

        const attrs = new Map() as MutableAttrMap;

        // SourceInclude: path is stored as the name (strings[0])
        // Macro: name is strings[0]
        // All other types: strings layout is [name, scope, fqn, signature?]
        if (type !== SymbolType.SourceInclude && type !== SymbolType.Macro) {
            // strings: [name, scope, fqn, signature?]
            if (strings[1]) {
                attrs.set(AttrKey.Scope, strings[1]);
            }
            if (strings[2]) {
                attrs.set(AttrKey.FullyQualifiedName, strings[2]);
            }
            if ((type === SymbolType.Function ||
                type === SymbolType.Method ||
                type === SymbolType.Constructor ||
                type === SymbolType.Destructor ||
                type === SymbolType.Prototype) && strings[3]) {
                attrs.set(AttrKey.Signature, strings[3]);
            }
        }

        // Scan optional tagged fields from index 9 onward
        for (let i = 9; i < nums.length;) {
            const marker = nums[i];
            const payload = NUMS_MARKER_PAYLOAD[marker];
            if (payload === undefined) break; // unknown marker — stop
            switch (marker) {
                case NumsMarker.BodyStart:
                    attrs.set(AttrKey.ContainerHeaderEndLine, nums[i + 1]);
                    attrs.set(AttrKey.ContainerHeaderEndColumn, nums[i + 2]);
                    break;
            }
            i += 1 + payload;
        }

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
