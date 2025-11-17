// Copyright (c) 2025 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import { createMarkdownCodeBlock } from '../common/markdownUtils';

/**
 * Input parameters for finding references
 */
export interface ITextDocumentReferencesParams {
    uri: string;
    position: {
        line: number;
        character: number;
    };
    symbolName: string;
    sourceLine: string;
}

/**
 * Group of references within a range of lines.
 * The references contained in a group all fall
 * within the startLine and endLine. This is used
 * to cluster references when displaying them since
 * multiple references may have overlapping source
 * contexts and we want to avoid duplication in the
 * output.
 */
interface ReferenceGroup {
    references: vscode.Location[];
    startLine: number;
    endLine: number;
}

/**
 * Get Document Symbol References Tool - Find all references to a symbol
 * Uses VS Code's built-in reference provider
 */
export class GetDocumentSymbolReferencesTool implements vscode.LanguageModelTool<ITextDocumentReferencesParams> {
    private contextLinesBefore: number = 10;
    private contextLinesAfter: number = 10;

    constructor() { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ITextDocumentReferencesParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { uri, position, symbolName } = options.input;
        const fileName = uri.split('/').pop() || uri;

        return {
            invocationMessage: `Finding references to '${symbolName}' at ${fileName}:${position.line + 1}:${position.character + 1}`,
            confirmationMessages: {
                title: 'Find References',
                message: new vscode.MarkdownString(
                    `Find all references to the symbol **${symbolName}** at:\n\n` +
                    `- **File**: \`${fileName}\`\n` +
                    `- **Line**: ${position.line + 1}\n` +
                    `- **Column**: ${position.character + 1}`
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ITextDocumentReferencesParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { uri, position, symbolName, sourceLine } = options.input;

        try {
            // Parse the URI
            const parsedUri = vscode.Uri.parse(uri);

            // Open the document (VS Code will handle this internally)
            const document = await vscode.workspace.openTextDocument(parsedUri);

            // Get the exact position by verifying the source line and symbol
            // This helps in cases where the agent might have been off by one
            // or more lines when providing the position.
            const vscodePosition = await this.resolveExactPosition(
                document,
                position,
                symbolName,
                sourceLine
            );

            // Use VS Code's built-in command which handles language server communication
            // This works even for files that aren't open because VS Code manages it
            const references = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeReferenceProvider',
                document.uri,
                vscodePosition
            ) || [];

            const consolidatedReferences = await this.consolidateReferences(
                references,
                this.contextLinesBefore,
                this.contextLinesAfter
            );

            const markdown = await this.getMarkdownFromReferences(
                symbolName,
                uri,
                vscodePosition,
                sourceLine,
                consolidatedReferences
            );

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(markdown),
            ]);
        } catch (error: any) {
            throw new Error(`Failed to find references: ${error.message}. Verify the file URI and position are correct.`);
        }
    }

    private async consolidateReferences(
        references: vscode.Location[],
        contextLinesBefore: number,
        contextLinesAfter: number
    ): Promise<ReferenceGroup[]> {
        const referenceGroups: ReferenceGroup[] = [];

        // Start by getting the context ranges for each reference
        for (let i = 0; i < references.length; i++) {
            const range = await this.getSourceContextRangeFromLocation(
                references[i],
                contextLinesBefore,
                contextLinesAfter
            );
            referenceGroups.push({
                references: [references[i]],
                startLine: range.start.line,
                endLine: range.end.line
            });
        }

        // Now that we have the desired source context ranges
        // for each reference, consolidate overlapping or adjacent
        // reference groups in the same file

        // Group references by URI
        const groupsByUri = new Map<string, ReferenceGroup[]>();
        for (const group of referenceGroups) {
            const uri = group.references[0].uri.toString();
            if (!groupsByUri.has(uri)) {
                groupsByUri.set(uri, []);
            }
            groupsByUri.get(uri)!.push(group);
        }

        // Consolidate groups within each file
        const consolidated: ReferenceGroup[] = [];
        for (const [uri, groups] of groupsByUri) {
            // Sort groups by startLine
            groups.sort((a, b) => a.startLine - b.startLine);

            // Merge overlapping or adjacent groups
            let currentGroup = groups[0];
            for (let i = 1; i < groups.length; i++) {
                const nextGroup = groups[i];

                // Check if groups overlap or are adjacent
                if (nextGroup.startLine <= currentGroup.endLine + 1) {
                    // Merge: extend the current group and add references
                    currentGroup.endLine = Math.max(currentGroup.endLine, nextGroup.endLine);
                    currentGroup.references.push(...nextGroup.references);
                } else {
                    // No overlap, push current and start a new one
                    consolidated.push(currentGroup);
                    currentGroup = nextGroup;
                }
            }
            // Don't forget the last group
            consolidated.push(currentGroup);
        }

        return consolidated;
    }

    /**
     * Generate markdown output from references
     * @param symbolName The name of the symbol
     * @param uri The original URI
     * @param position The resolved position
     * @param sourceLine The source line text
     * @param references Array of reference locations
     * @returns Formatted markdown string
     */
    private async getMarkdownFromReferences(
        symbolName: string,
        uri: string,
        position: vscode.Position,
        sourceLine: string,
        references: ReferenceGroup[]
    ): Promise<string> {
        const totalReferences = references.reduce((sum, group) => sum + group.references.length, 0);

        const markdownParts: string[] = [];
        markdownParts.push(`# References for \`${symbolName}\``);
        markdownParts.push('');
        markdownParts.push(`**Total References:** ${totalReferences}`);
        markdownParts.push('');
        markdownParts.push('## Original Symbol Location');
        markdownParts.push('');
        markdownParts.push(`- **URI**: ${decodeURIComponent(uri)}`);
        markdownParts.push(`- **Line**: ${position.line + 1}`);
        markdownParts.push(`- **Character**: ${position.character + 1}`);
        markdownParts.push(`- **Source Line**: \`${sourceLine}\``);
        markdownParts.push('');

        if (references.length > 0) {
            for (let i = 0; i < references.length; i++) {
                const ref = references[i];
                const uri = ref.references[0].uri.toString();
                const sourceContext = await this.getSourceContext(ref);
                const positionStrings =
                    ref.references.map(
                        r => `L${r.range.start.line + 1}:${r.range.start.character + 1}`
                    ).join(', ');

                markdownParts.push(`## References ${i + 1}`);
                markdownParts.push('');
                markdownParts.push(`- **URI**: ${decodeURIComponent(uri)}`);
                markdownParts.push(`- **Locations** (${ref.references.length} references): ${positionStrings}`);
                markdownParts.push('');
                markdownParts.push('**Source Context:**');
                markdownParts.push('');
                markdownParts.push(...sourceContext);
                markdownParts.push('');
            }
        }

        return markdownParts.join('\n');
    }

    /**
     * Resolve the exact position by matching the source line and finding the symbol
     * @param document The document to search in
     * @param position The approximate position
     * @param symbolName The name of the symbol to find
     * @param sourceLine The exact source line content
     * @returns The exact position of the symbol
     * @throws Error if the source line or symbol cannot be found
     */
    private async resolveExactPosition(
        document: vscode.TextDocument,
        position: { line: number; character: number },
        symbolName: string,
        sourceLine: string
    ): Promise<vscode.Position> {
        // Search for the matching line within a reasonable range (±5 lines)
        const searchRange = 5;
        const startLine = Math.max(0, position.line - searchRange);
        const endLine = Math.min(document.lineCount - 1, position.line + searchRange);

        for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
            const line = document.lineAt(lineNum);

            // Check if this line matches the source line
            if (line.text.trim() === sourceLine.trim()) {
                // TODO: handle the case where multiple instances
                // of the symbol exist on the same line.

                // Found the matching line, now find the symbol within it
                const symbolIndex = line.text.indexOf(symbolName);

                if (symbolIndex !== -1) {
                    // Return the position at the start of the symbol
                    return new vscode.Position(lineNum, symbolIndex);
                }

                // Found matching line but symbol not on it
                throw new Error(
                    `Found matching source line at line ${lineNum + 1}, but symbol '${symbolName}' ` +
                    `was not found on that line. Line content: "${line.text}"`
                );
            }
        }

        // Could not find the matching source line
        throw new Error(
            `Could not find source line "${sourceLine}" within ±${searchRange} lines of line ${position.line + 1}. ` +
            `Searched lines ${startLine + 1} to ${endLine + 1}. Please verify the position and source line are correct.`
        );
    }

    /**
     * Get the source context range from a location
     * @param location The location to get context from
     * @param numLinesBefore Number of lines before the location to include
     * @param numLinesAfter Number of lines after the location to include
     * @returns The range of source context, constrained by method boundaries if found
     */
    private async getSourceContextRangeFromLocation(
        location: vscode.Location,
        numLinesBefore: number,
        numLinesAfter: number
    ): Promise<vscode.Range> {
        try {
            const document = await vscode.workspace.openTextDocument(location.uri);

            // Get document symbols to find containing method/function
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                location.uri
            );

            // Find the containing method/function
            let methodRange: vscode.Range | undefined;
            if (symbols) {
                methodRange = this.findContainingMethod(symbols, location.range.start);
            }

            // Calculate start and end lines, constrained by method boundaries if found
            let startLine = Math.max(0, location.range.start.line - numLinesBefore);
            let endLine = Math.min(document.lineCount - 1, location.range.start.line + numLinesAfter);

            if (methodRange) {
                // Constrain to method boundaries
                startLine = Math.max(startLine, methodRange.start.line);
                endLine = Math.min(endLine, methodRange.end.line);
            }

            const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
            return range;
        } catch (error: any) {
            return location.range;
        }
    }

    /**
     * Get source context from a reference group
     * @param referenceGroup The reference group containing locations and line range
     * @returns Array of markdown lines including code block
     */
    private async getSourceContext(
        referenceGroup: ReferenceGroup,
    ): Promise<string[]> {
        try {
            const uri = referenceGroup.references[0].uri;
            const range = new vscode.Range(
                referenceGroup.startLine, 0,
                referenceGroup.endLine, 0
            );
            const document = await vscode.workspace.openTextDocument(uri);
            const codeBlock = createMarkdownCodeBlock(document, range);
            return [`Showing source lines from ${range.start.line + 1} - ${range.end.line + 1}:`, ...codeBlock];
        } catch (error: any) {
            return [`Error reading source: ${error.message}`];
        }
    }

    /**
     * Find the containing method/function for a position
     * @param symbols Document symbols to search
     * @param position Position to find container for
     * @returns Range of the containing method/function, or undefined if not found
     */
    private findContainingMethod(
        symbols: vscode.DocumentSymbol[],
        position: vscode.Position
    ): vscode.Range | undefined {
        for (const symbol of symbols) {
            // Check if this symbol contains the position
            if (symbol.range.contains(position)) {
                // Check if this is a method or function
                if (
                    symbol.kind === vscode.SymbolKind.Method ||
                    symbol.kind === vscode.SymbolKind.Function ||
                    symbol.kind === vscode.SymbolKind.Constructor
                ) {
                    return symbol.range;
                }

                // Recursively search children
                if (symbol.children && symbol.children.length > 0) {
                    const childResult = this.findContainingMethod(symbol.children, position);
                    if (childResult) {
                        return childResult;
                    }
                }

                // If we're in a class/namespace/etc but not in a method, check children
                if (symbol.children && symbol.children.length > 0) {
                    continue;
                }
            }
        }

        return undefined;
    }
}
