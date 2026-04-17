// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ContentIndex, NearestEmbeddingResult } from '../../common/index';
import { ScopedFileCache } from '../../common/scopedFileCache';
import {
    ChunkRef,
    ResolvedTrainingSample,
} from './generatePerFileEmbeddingTrainingData';

// ── Types ─────────────────────────────────────────────────────────────

/** Verification result for a single negative */
interface NegativeVerification {
    chunk: ChunkRef;
    /** Whether this negative was found in the current search results */
    foundInSearchResults: boolean;
    /** Similarity score from the embedding search, if found */
    score?: number;
}

/** Verification result for a single training sample */
interface VerifiedSample {
    sample: ResolvedTrainingSample;
    hardNegativeResults: NegativeVerification[];
    easyNegativeResults: NegativeVerification[];
}

// ── JSONL loading ─────────────────────────────────────────────────────

/**
 * Read a JSONL file and parse each line as a ResolvedTrainingSample.
 * Skips blank lines; throws on invalid JSON.
 */
async function loadTrainingData(filePath: string): Promise<ResolvedTrainingSample[]> {
    const content = await fs.promises.readFile(filePath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    return lines.map((line, i) => {
        try {
            return JSON.parse(line) as ResolvedTrainingSample;
        } catch {
            throw new Error(`Invalid JSON on line ${i + 1} of ${filePath}`);
        }
    });
}

// ── Search verification ───────────────────────────────────────────────

/**
 * Find a ChunkRef in the search results and return the matching result.
 * Comparison is by filePath, startLine, and endLine.
 */
function findChunkInSearchResults(
    chunk: ChunkRef,
    searchResults: NearestEmbeddingResult[],
): NearestEmbeddingResult | undefined {
    return searchResults.find(r =>
        r.filePath === chunk.filePath
        && r.startLine === chunk.startLine
        && r.endLine === chunk.endLine
    );
}

/**
 * Verify a single training sample by running the query through the
 * embedding index and checking each negative against the results.
 */
async function verifySample(
    sample: ResolvedTrainingSample,
    contentIndex: ContentIndex,
    topK: number,
): Promise<VerifiedSample> {
    // Run the embedding search covering both hard and easy negative ranges
    const searchResults = await contentIndex.searchEmbeddings(sample.query, topK);

    // Check each hard negative against the search results
    const hardNegativeResults: NegativeVerification[] = sample.hardNegatives.map(chunk => {
        const match = findChunkInSearchResults(chunk, searchResults);
        return {
            chunk,
            foundInSearchResults: !!match,
            score: match?.score,
        };
    });

    // Check each easy negative against the search results
    const easyNegativeResults: NegativeVerification[] = sample.easyNegatives.map(chunk => {
        const match = findChunkInSearchResults(chunk, searchResults);
        return {
            chunk,
            foundInSearchResults: !!match,
            score: match?.score,
        };
    });

    return { sample, hardNegativeResults, easyNegativeResults };
}

// ── Markdown formatting ───────────────────────────────────────────────

/**
 * Format a ChunkRef as a markdown section with hydrated file content.
 * Reads file content via fileCache and renders numbered lines in a code block.
 */
async function formatChunkRefAsMarkdown(
    ref: ChunkRef,
    fileCache: ScopedFileCache,
): Promise<string> {
    let md = `**${ref.filePath}** (lines ${ref.startLine}-${ref.endLine})\n\n`;
    try {
        const allLines = await fileCache.getLines(ref.filePath);
        const lines = allLines.slice(ref.startLine - 1, ref.endLine);
        const numbered = lines.map((line, i) => `${ref.startLine + i}: ${line}`).join('\n');
        md += `\`\`\`\n${numbered}\n\`\`\`\n\n`;
    } catch {
        md += `\`\`\`\n[unable to read file content]\n\`\`\`\n\n`;
    }
    return md;
}

/**
 * Format a single verified sample as markdown. Hard negatives that were
 * not found in the current search results are annotated with
 * [NOT IN SEARCH RESULTS].
 */
async function formatVerifiedSampleAsMarkdown(
    index: number,
    verified: VerifiedSample,
    fileCache: ScopedFileCache,
): Promise<string> {
    const { sample, hardNegativeResults, easyNegativeResults } = verified;
    let md = `# Sample ${index + 1}: ${sample.query}\n\n`;
    md += `**Query Type:** ${sample.queryType}\n\n`;

    // Positive chunk
    md += `## Positive\n\n`;
    md += await formatChunkRefAsMarkdown(sample.positive, fileCache);

    // Hard negatives with verification annotations
    if (hardNegativeResults.length > 0) {
        md += `## Hard Negatives (${hardNegativeResults.length})\n\n`;
        for (let j = 0; j < hardNegativeResults.length; j++) {
            const { chunk, foundInSearchResults, score } = hardNegativeResults[j];
            const scoreTag = score !== undefined ? ` (score: ${score.toFixed(4)})` : '';
            const tag = foundInSearchResults ? scoreTag : ' [NOT IN SEARCH RESULTS]';
            md += `### Hard Negative ${j + 1}${tag}\n\n`;
            md += await formatChunkRefAsMarkdown(chunk, fileCache);
        }
    }

    // Easy negatives with verification annotations
    if (easyNegativeResults.length > 0) {
        md += `## Easy Negatives (${easyNegativeResults.length})\n\n`;
        for (let j = 0; j < easyNegativeResults.length; j++) {
            const { chunk, foundInSearchResults, score } = easyNegativeResults[j];
            const scoreTag = score !== undefined ? ` (score: ${score.toFixed(4)})` : '';
            const tag = foundInSearchResults ? scoreTag : ' [NOT IN SEARCH RESULTS]';
            md += `### Easy Negative ${j + 1}${tag}\n\n`;
            md += await formatChunkRefAsMarkdown(chunk, fileCache);
        }
    }

    return md;
}

/**
 * Build the complete verification report from all verified samples.
 * Includes a summary header with mismatch counts followed by each
 * sample's detailed markdown.
 */
async function buildVerificationReport(
    verifiedSamples: VerifiedSample[],
    fileCache: ScopedFileCache,
    sourceFileName: string,
): Promise<string> {
    // Count how many negatives were not found across all samples
    let totalHardNegatives = 0;
    let hardMismatches = 0;
    let totalEasyNegatives = 0;
    let easyMismatches = 0;
    for (const v of verifiedSamples) {
        for (const hn of v.hardNegativeResults) {
            totalHardNegatives++;
            if (!hn.foundInSearchResults) {
                hardMismatches++;
            }
        }
        for (const en of v.easyNegativeResults) {
            totalEasyNegatives++;
            if (!en.foundInSearchResults) {
                easyMismatches++;
            }
        }
    }

    // Summary header
    let report = `# Verification Report: ${sourceFileName}\n\n`;
    report += `**Samples:** ${verifiedSamples.length}\n\n`;
    report += `**Hard Negatives:** ${totalHardNegatives} | `;
    report += `**Not In Search Results:** ${hardMismatches}\n\n`;
    report += `**Easy Negatives:** ${totalEasyNegatives} | `;
    report += `**Not In Search Results:** ${easyMismatches}\n\n`;
    report += `---\n\n`;

    // Each sample's detailed output
    const sections: string[] = [];
    for (let i = 0; i < verifiedSamples.length; i++) {
        sections.push(await formatVerifiedSampleAsMarkdown(i, verifiedSamples[i], fileCache));
    }

    report += sections.join('\n---\n\n');
    return report;
}

// ── Main command ────────────────────────────────────────────────────

export class OpenPerFileEmbeddingTrainingDataCommand {
    public readonly id = 'vscToolbox.openPerFileEmbeddingTrainingData';
    public readonly title = 'VSC Toolbox: Open Per-File Embedding Training Data';

    constructor(private context: vscode.ExtensionContext) { }

    async execute(): Promise<void> {
        // Step 1: Prompt the user to select a JSONL training data file
        const fileUri = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'Training Data': ['jsonl'] },
            title: 'Select Training Data JSONL File',
        });

        if (!fileUri || fileUri.length === 0) {
            return;
        }

        const filePath = fileUri[0].fsPath;
        const fileName = path.basename(filePath);

        // Step 2: Load and parse the training data
        let samples: ResolvedTrainingSample[];
        try {
            samples = await loadTrainingData(filePath);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to load training data: ${err.message}`);
            return;
        }

        if (samples.length === 0) {
            vscode.window.showWarningMessage('Training data file is empty');
            return;
        }

        // Step 3: Prompt user for topK value
        const topKInput = await vscode.window.showInputBox({
            prompt: 'Maximum number of search results to validate negatives against (topK)',
            value: '2000',
            validateInput: (value) => {
                const n = Number(value);
                if (!Number.isInteger(n) || n < 1) {
                    return 'Please enter a positive integer';
                }
                return undefined;
            },
        });

        if (!topKInput) {
            return;
        }

        const topK = Number(topKInput);

        // Step 4: Verify each sample's negatives against current search results
        const contentIndex = ContentIndex.getInstance();
        const fileCache = new ScopedFileCache();

        const verifiedSamples: VerifiedSample[] = [];

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'VSC Toolbox: Opening Training Data File',
                cancellable: true,
            },
            async (progress, token) => {
                for (let i = 0; i < samples.length; i++) {
                    if (token.isCancellationRequested) {
                        break;
                    }

                    progress.report({
                        increment: (1 / samples.length) * 100,
                        message: `${i + 1}/${samples.length} samples`,
                    });

                    const verified = await verifySample(samples[i], contentIndex, topK);
                    verifiedSamples.push(verified);
                }
            },
        );

        if (verifiedSamples.length === 0) {
            vscode.window.showWarningMessage('No samples could be verified');
            return;
        }

        // Step 4: Build the markdown report and display in a new editor tab
        const report = await buildVerificationReport(verifiedSamples, fileCache, fileName);

        const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown',
        });
        await vscode.window.showTextDocument(doc);
    }
}
