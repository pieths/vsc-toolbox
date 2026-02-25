// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import picomatch from 'picomatch';
import { createMarkdownCodeBlock } from '../common/markdownUtils';
import { getFunctionSignatureRange } from '../common/documentUtils';
import { ContentIndex, IndexSymbol, AttrKey, symbolTypeToString, CALLABLE_TYPES } from '../common/index';
import { ScopedFileCache } from '../common/scopedFileCache';
import { getModel, sendRequestWithReadFileAccess } from '../common/copilotUtils';
import { log } from '../common/logger';

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
    include?: string;
    exclude?: string;
    filter?: string;
}

interface SourceContext {
    sourceLines: string[];
    range: vscode.Range;
}

/**
 * Group of references within a range of lines.  The references contained in a
 * group all fall within the range start.line and end.line. This is used to
 * cluster references when displaying them since multiple references may have
 * overlapping source contexts and we want to avoid duplication in the output.
 * If the container is set, it indicates the container that contains all
 * references in this group.
 */
interface ReferenceGroup {
    references: vscode.Location[];
    range: vscode.Range;
    container?: IndexSymbol;
    containerFullName?: string;
}

/**
 * Get Document Symbol References Tool - Find all references to a symbol
 * Uses VS Code's built-in reference provider
 */
export class GetDocumentSymbolReferencesTool implements vscode.LanguageModelTool<ITextDocumentReferencesParams> {
    private contextLinesBefore: number = 10;
    private contextLinesAfter: number = 10;

    constructor(_context: vscode.ExtensionContext) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ITextDocumentReferencesParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { uri, position, symbolName, include, exclude, filter } = options.input;
        const fileName = uri.split('/').pop() || uri;
        const filterInfo = filter ? ` filtered by: ${filter}` : '';
        const pathFilterInfo = include || exclude
            ? ` [paths: ${include ? `include=${include}` : ''}${include && exclude ? ', ' : ''}${exclude ? `exclude=${exclude}` : ''}]`
            : '';

        return {
            invocationMessage: `Finding references to '${symbolName}' at ${fileName}:${position.line + 1}:${position.character + 1}${pathFilterInfo}${filterInfo}`,
            confirmationMessages: {
                title: 'Find References',
                message: new vscode.MarkdownString(
                    `Find all references to the symbol **${symbolName}** at:\n\n` +
                    `- **File**: \`${fileName}\`\n` +
                    `- **Line**: ${position.line + 1}\n` +
                    `- **Column**: ${position.character + 1}` +
                    (include ? `\n- **Include**: \`${include}\`` : '') +
                    (exclude ? `\n- **Exclude**: \`${exclude}\`` : '') +
                    (filter ? `\n\nFilter: ${filter}` : '')
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ITextDocumentReferencesParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { uri, position, symbolName, sourceLine, include, exclude, filter } = options.input;

        // Create a file cache for this invocation to avoid repeated file reads
        const fileCache = new ScopedFileCache();

        try {
            // Parse the URI
            const parsedUri = vscode.Uri.parse(uri);

            // Read file contents via cache
            const lines = await fileCache.getLines(parsedUri.fsPath);

            // Get the exact position by verifying the source line and symbol
            // This helps in cases where the agent might have been off by one
            // or more lines when providing the position.
            const vscodePosition = await this.resolveExactPosition(
                lines,
                position,
                symbolName,
                sourceLine
            );

            // Use VS Code's built-in command which handles language server communication
            // This works even for files that aren't open because VS Code manages it
            const referenceSearchStart = Date.now();
            const references = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeReferenceProvider',
                parsedUri,
                vscodePosition
            ) || [];
            const referenceSearchElapsed = Date.now() - referenceSearchStart;
            log(`Reference search took ${referenceSearchElapsed}ms for: ${symbolName}`);

            let verifiedReferences = await this.verifyReferences(references, symbolName, fileCache);

            // Apply include/exclude glob filtering on file paths
            if (include || exclude) {
                const includePatterns = include ? include.split(',').map(p => p.trim()).filter(p => p) : [];
                const excludePatterns = exclude ? exclude.split(',').map(p => p.trim()).filter(p => p) : [];
                const includeRegexes = includePatterns.map(p => picomatch.makeRe(p, { windows: true }));
                const excludeRegexes = excludePatterns.map(p => picomatch.makeRe(p, { windows: true }));

                verifiedReferences = verifiedReferences.filter(ref => {
                    const refPath = ref.uri.fsPath;
                    if (includeRegexes.length > 0 && !includeRegexes.some(re => re.test(refPath))) {
                        return false;
                    }
                    if (excludeRegexes.length > 0 && excludeRegexes.some(re => re.test(refPath))) {
                        return false;
                    }
                    return true;
                });
            }

            const consolidatedReferences = await this.consolidateReferences(
                verifiedReferences,
                this.contextLinesBefore,
                this.contextLinesAfter,
                fileCache
            );

            const markdown = await this.getMarkdownFromReferences(
                symbolName,
                uri,
                vscodePosition,
                sourceLine,
                consolidatedReferences,
                fileCache
            );

            // Filter results using AI if a filter is provided
            const model = await getModel();
            let filteredMarkdown = markdown;
            if (model && filter) {
                log(`Starting AI filter with criteria: "${filter}"`);
                const filterStart = Date.now();
                const filterPrompt = [
                    'You are a filter.',
                    'Given the markdown below which contains symbol reference results (starts with line `# References for`),',
                    'apply the filter criteria from the "Filter" section below to keep or remove references as specified.',
                    'Return ONLY the filtered markdown with no additional commentary or explanation.',
                    'Preserve the exact format and content of the remaining text.',
                    'Do not add any additional text.',
                    'Only remove complete `## References ...` sections that don\'t satisfy the filter.',
                    'If removing a references section, remove the entire section including its header.',
                    // 'Update the **Total References:** count to reflect the filtered number of references.',
                    'If the filter criteria requires information not currently present in the markdown, use the appropriate tool(s) to get the required information.',
                    '',
                    '# Filter',
                    '',
                    '```',
                    filter,
                    '```',
                    '',
                    '',
                    markdown
                ].join('\n');
                filteredMarkdown = await sendRequestWithReadFileAccess(model, filterPrompt, _token, 1000, fileCache);
                const filterElapsed = Date.now() - filterStart;
                log(`AI filter completed in ${filterElapsed}ms`);
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(filteredMarkdown),
            ]);
        } catch (error: any) {
            throw new Error(`Failed to find references: ${error.message}. Verify the file URI and position are correct.`);
        } finally {
            // Clear cache at the end of the invocation
            fileCache.clear();
        }
    }

    /**
     * Verify that references actually contain the symbol at the specified location.
     * This filters out stale references that may occur due to language server bugs
     * (e.g., clangd retaining old locations when lines are removed from a file).
     * See: https://github.com/clangd/clangd/issues/2548
     * @param references Array of reference locations to verify
     * @param symbolName The name of the symbol to look for
     * @param fileCache Cache for file contents
     * @returns Filtered array containing only valid references
     */
    private async verifyReferences(
        references: vscode.Location[],
        symbolName: string,
        fileCache: ScopedFileCache
    ): Promise<vscode.Location[]> {
        const verifiedReferences: vscode.Location[] = [];

        // Escape special regex characters in the symbol name
        const escapedSymbol = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const symbolRegex = new RegExp(`\\b${escapedSymbol}\\b`, 'g');

        // Group references by URI to minimize file reads
        const refsByUri = new Map<string, vscode.Location[]>();
        for (const ref of references) {
            const uriStr = ref.uri.toString();
            if (!refsByUri.has(uriStr)) {
                refsByUri.set(uriStr, []);
            }
            refsByUri.get(uriStr)!.push(ref);
        }

        // Verify references for each file
        for (const [uriStr, refs] of refsByUri) {
            try {
                const uri = vscode.Uri.parse(uriStr);
                const lines = await fileCache.getLines(uri.fsPath);

                for (const ref of refs) {
                    const line = ref.range.start.line;

                    // Check if line is within file bounds
                    if (line < 0 || line >= lines.length) {
                        continue;
                    }

                    const lineText = lines[line];

                    // Skip if character position is past end of line
                    if (ref.range.start.character >= lineText.length) {
                        continue;
                    }

                    // Verify the symbol exists at the exact position specified
                    // by the reference. If not, the reference is stale.
                    symbolRegex.lastIndex = ref.range.start.character;
                    const match = symbolRegex.exec(lineText);
                    if (match && match.index === ref.range.start.character) {
                        verifiedReferences.push(ref);
                    }
                }
            } catch (error) {
                // If we can't read the file, skip these references
                continue;
            }
        }

        return verifiedReferences;
    }

    private async consolidateReferences(
        references: vscode.Location[],
        contextLinesBefore: number,
        contextLinesAfter: number,
        fileCache: ScopedFileCache
    ): Promise<ReferenceGroup[]> {
        const referenceGroups: ReferenceGroup[] = [];
        const batchSize = 20;

        for (let i = 0; i < references.length; i += batchSize) {
            const batch = references.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(ref => this.getReferenceGroupFromLocation(
                    ref,
                    contextLinesBefore,
                    contextLinesAfter,
                    fileCache))
            );
            referenceGroups.push(...batchResults);
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
            groups.sort((a, b) => a.range.start.line - b.range.start.line);

            // Merge overlapping or adjacent groups with the same container
            let currentGroup = groups[0];
            for (let i = 1; i < groups.length; i++) {
                const nextGroup = groups[i];

                // Check if containers match (both undefined, or same container by startLine and name)
                const containersMatch =
                    (currentGroup.container === undefined && nextGroup.container === undefined) ||
                    (currentGroup.container !== undefined &&
                        nextGroup.container !== undefined &&
                        currentGroup.container.startLine === nextGroup.container.startLine &&
                        currentGroup.container.name === nextGroup.container.name);

                // Check if groups have the same container and overlap or are adjacent
                if (containersMatch &&
                    nextGroup.range.start.line <= currentGroup.range.end.line + 1) {
                    // Merge: extend the current group and add references
                    currentGroup.range = currentGroup.range.union(nextGroup.range);
                    currentGroup.references.push(...nextGroup.references);
                } else {
                    // No overlap or different container, push current and start a new one
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
     * @param fileCache Cache for file contents
     * @returns Formatted markdown string
     */
    private async getMarkdownFromReferences(
        symbolName: string,
        uri: string,
        position: vscode.Position,
        sourceLine: string,
        references: ReferenceGroup[],
        fileCache: ScopedFileCache
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
            // Fetch all source contexts in batches of 20 (I/O bound)
            const containerSourceContexts = await this.getContainerSourceContexts(references, 20, fileCache);
            const sourceContexts = await this.getSourceContexts(references, 20, fileCache);

            let cumulativeRefIndex = 1;
            for (let i = 0; i < references.length; i++) {
                const ref = references[i];
                const uri = ref.references[0].uri.toString();
                const sourceContext = sourceContexts[i];
                const positionStrings =
                    ref.references.map(
                        r => `L${r.range.start.line + 1}:${r.range.start.character + 1}`
                    ).join(', ');

                // Show range if multiple references in this group, otherwise single number
                const refCount = ref.references.length;
                const refLabel = refCount === 1
                    ? `${cumulativeRefIndex}`
                    : `${cumulativeRefIndex}-${cumulativeRefIndex + refCount - 1}`;

                markdownParts.push(`## References ${refLabel}`);
                markdownParts.push('');
                markdownParts.push(`- **URI**: ${decodeURIComponent(uri)}`);
                markdownParts.push(`- **Locations** (${ref.references.length} references): ${positionStrings}`);
                markdownParts.push('');
                markdownParts.push('**Source Context:**');

                // If there is only one location contained in this reference group,
                // and it matches the container symbol (aka. location and container
                // both reference the same method name), then adjust output accordingly.
                // IndexSymbol uses 0-based line numbers, same as VS Code
                const locationMatchesContainer = ref.container &&
                    ref.references.length == 1 &&
                    ref.container.startLine === ref.references[0].range.start.line;
                // ^ TODO: update this to add name check

                if (ref.containerFullName) {
                    const containerKind = symbolTypeToString(ref.container!.type);
                    markdownParts.push('');

                    if (locationMatchesContainer) {
                        markdownParts.push(`${containerKind} full name: \`${ref.containerFullName}\``);
                    } else {
                        markdownParts.push(`References contained in ${containerKind}: \`${ref.containerFullName}\``);
                    }
                }

                if (containerSourceContexts[i] && !locationMatchesContainer) {
                    const context = containerSourceContexts[i];
                    const startLineNum = context.range.start.line + 1;
                    const endLineNum = context.range.end.line + 1;
                    const containerKind = symbolTypeToString(ref.container!.type);
                    markdownParts.push('');
                    markdownParts.push(`${containerKind} signature (showing source lines ${startLineNum} - ${endLineNum}): `);
                    markdownParts.push(...context.sourceLines);
                }

                markdownParts.push('');
                markdownParts.push(`Showing references in source lines ${sourceContext.range.start.line + 1} - ${sourceContext.range.end.line + 1}: `);
                markdownParts.push(...sourceContext.sourceLines);
                markdownParts.push('');

                cumulativeRefIndex += refCount;
            }
        }

        return markdownParts.join('\n');
    }

    /**
     * Resolve the exact position by matching the source line and finding the symbol
     * @param lines The lines of the file to search in
     * @param position The approximate position
     * @param symbolName The name of the symbol to find
     * @param sourceLine The exact source line content
     * @returns The exact position of the symbol
     * @throws Error if the source line or symbol cannot be found
     */
    private async resolveExactPosition(
        lines: string[],
        position: { line: number; character: number },
        symbolName: string,
        sourceLine: string
    ): Promise<vscode.Position> {
        // Search for the matching line, checking position.line first.
        // offsets = [0, -1, 1, -2, 2, -3, 3, ...]
        const range = 5;
        const offsets = [0, ...Array.from({ length: range }, (_, i) => [-(i + 1), i + 1]).flat()];

        // Regex with word boundaries to find whole-word matches only.
        // Escape special regex characters in the symbol name
        const escapedSymbol = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const symbolRegex = new RegExp(`\\b${escapedSymbol}\\b`, 'g');

        for (const offset of offsets) {
            const lineNum = position.line + offset;

            // Skip if line is out of bounds
            if (lineNum < 0 || lineNum >= lines.length) {
                continue;
            }

            const lineText = lines[lineNum];

            // Check if this line matches the source line
            if (lineText.trim() === sourceLine.trim()) {
                // Find all whole-word instances of the symbol on this line
                const symbolIndices: number[] = [];
                symbolRegex.lastIndex = 0; // Reset regex state
                let match;
                while ((match = symbolRegex.exec(lineText)) !== null) {
                    symbolIndices.push(match.index);
                }

                if (symbolIndices.length === 0) {
                    // Found matching line but symbol not on it
                    throw new Error(
                        `Found matching source line at line ${lineNum + 1}, but symbol '${symbolName}' ` +
                        `was not found on that line. Line content: "${lineText}"`
                    );
                }

                // First, check if the cursor position falls within any match
                const containingIndex = symbolIndices.find(idx =>
                    position.character >= idx && position.character < idx + symbolName.length
                );

                if (containingIndex !== undefined) {
                    return new vscode.Position(lineNum, containingIndex);
                }

                // Fall back to choosing the symbol instance
                // closest to the provided character position
                const closestIndex = symbolIndices.reduce((closest, current) =>
                    Math.abs(current - position.character) < Math.abs(closest - position.character)
                        ? current
                        : closest
                );

                // Return the position at the start of the closest symbol
                return new vscode.Position(lineNum, closestIndex);
            }
        }

        // Could not find the matching source line
        throw new Error(
            `Could not find source line within ±${range} lines of line ${position.line + 1}. ` +
            `Please verify the position and source line are correct.`
        );
    }

    private async getReferenceGroupFromLocation(
        location: vscode.Location,
        numLinesBefore: number,
        numLinesAfter: number,
        fileCache: ScopedFileCache
    ): Promise<ReferenceGroup> {
        try {
            const filePath = location.uri.fsPath;
            const lines = await fileCache.getLines(filePath);

            // Get container from ContentIndex (uses 0-based line numbers)
            const container = await ContentIndex.getInstance().getContainer(
                filePath,
                location.range.start.line
            );

            // Calculate start and end lines, constrained by method boundaries if found
            let startLine = Math.max(0, location.range.start.line - numLinesBefore);
            let endLine = Math.min(lines.length - 1, location.range.end.line + numLinesAfter);

            let containerFullName: string | undefined;
            if (container) {
                // Constrain to container boundaries (already 0-based)
                const containerStart = container.startLine;
                const containerEnd = container.endLine;

                startLine = Math.max(startLine, containerStart);
                endLine = Math.min(endLine, containerEnd);

                // Now maximize the range within container boundaries
                // Calculate how much context we wanted vs what we got
                const maxContextLines = numLinesBefore + numLinesAfter + (location.range.end.line - location.range.start.line);
                const currentContextLines = endLine - startLine;
                const missingLines = maxContextLines - currentContextLines;

                if (missingLines > 0) {
                    // Try to expand the range to use the full context budget
                    // First try expanding upwards
                    const availableAbove = startLine - containerStart;
                    const expandAbove = Math.min(availableAbove, missingLines);
                    startLine -= expandAbove;

                    let remaining = missingLines - expandAbove;
                    if (remaining > 0) {
                        // Then try expanding downwards
                        const availableBelow = containerEnd - endLine;
                        const expandBelow = Math.min(availableBelow, remaining);
                        endLine += expandBelow;
                    }
                }

                // At this point, the range is maximized within container boundaries
                // while still being within the constraints of the maximum context
                // window size and the following should hold true:
                // containerStart ≤ startLine ≤ endLine ≤ containerEnd

                containerFullName = container.attrs.get(AttrKey.FullyQualifiedName) ?? container.name;
            }

            const endLineLength = lines[endLine].length;
            const range = new vscode.Range(
                new vscode.Position(startLine, 0),
                new vscode.Position(endLine, endLineLength)
            );

            return {
                references: [location],
                range,
                container: container ?? undefined,
                containerFullName
            };
        } catch (error: any) {
            return {
                references: [location],
                range: location.range
            };
        }
    }

    /**
     * Get container signature source contexts for all reference groups
     * @param references Array of reference groups
     * @param batchSize Number of groups to process in parallel
     * @param fileCache Cache for file contents
     * @returns Array of source contexts in the same order as input
     */
    private async getContainerSourceContexts(
        references: ReferenceGroup[],
        batchSize: number,
        fileCache: ScopedFileCache
    ): Promise<SourceContext[]> {
        const containerSignatureSourceContexts: SourceContext[] = [];
        const containerSignatureRanges: (vscode.Range | undefined)[] = [];

        // First, get all container signature ranges in batches
        for (let i = 0; i < references.length; i += batchSize) {
            const batch = references.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(async ref => {
                    // Only get signature range for callable containers
                    if (!ref.container) {
                        return undefined;
                    }

                    if (!CALLABLE_TYPES.has(ref.container.type)) {
                        return undefined;
                    }

                    const lines = await fileCache.getLines(ref.references[0].uri.fsPath);
                    // IndexSymbol positions are already 0-based
                    return getFunctionSignatureRange(lines, ref.container.startLine, ref.container.startColumn);
                })
            );
            containerSignatureRanges.push(...batchResults);
        }

        // For each reference group, check if the container signature
        // overlaps with the reference context window. If it does,
        // mark it as undefined to avoid showing it separately and
        // update the source context to include the container signature.
        for (let i = 0; i < references.length; i++) {
            const ref = references[i];
            const containerSignatureRange = containerSignatureRanges[i];

            // Check if signature overlaps with reference context
            // or is close (within 5 lines after)
            if (containerSignatureRange) {
                const delta = ref.range.start.line - containerSignatureRange.end.line;
                if (containerSignatureRange.intersection(ref.range) ||
                    (delta >= 0 && delta <= 5)) {
                    // Combine the signature with the source context so
                    // that only the source context is needed in the output
                    ref.range = ref.range.union(containerSignatureRange);
                    containerSignatureRanges[i] = undefined;
                }
            }
        }

        // Convert valid ranges to source contexts
        for (let i = 0; i < containerSignatureRanges.length; i++) {
            const range = containerSignatureRanges[i];
            if (range) {
                const ref = references[i];
                const context = await this.getSourceContext(ref.references[0].uri, range, fileCache);
                containerSignatureSourceContexts.push(context);
            } else {
                // Push undefined placeholder to maintain array alignment
                containerSignatureSourceContexts.push(undefined as any);
            }
        }

        return containerSignatureSourceContexts;
    }

    /**
     * Get source contexts for all reference groups in batches
     * @param references Array of reference groups
     * @param batchSize Number of groups to process in parallel
     * @param fileCache Cache for file contents
     * @returns Array of source contexts in the same order as input
     */
    private async getSourceContexts(
        references: ReferenceGroup[],
        batchSize: number,
        fileCache: ScopedFileCache
    ): Promise<SourceContext[]> {
        const allContexts: SourceContext[] = [];

        for (let i = 0; i < references.length; i += batchSize) {
            const batch = references.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(ref => this.getSourceContext(ref.references[0].uri, ref.range, fileCache))
            );
            allContexts.push(...batchResults);
        }

        return allContexts;
    }

    /**
     * Get source context from a reference group
     * @param uri The URI of the file
     * @param range The range of lines to get context for
     * @param fileCache Cache for file contents
     * @returns Source context with lines and range
     */
    private async getSourceContext(
        uri: vscode.Uri,
        range: vscode.Range,
        fileCache: ScopedFileCache
    ): Promise<SourceContext> {
        try {
            const filePath = uri.fsPath;
            const lines = await fileCache.getLines(filePath);
            const codeBlock = createMarkdownCodeBlock(lines, range, filePath);
            return {
                sourceLines: codeBlock,
                range
            };
        } catch (error: any) {
            return {
                sourceLines: [`Error reading source: ${error.message} `],
                range: range
            };
        }
    }
}
