// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ContentIndex } from '../../common/index';
import { log } from '../../common/logger';
import { ChunkRef, TrainingSample } from './types';

// ── Types ─────────────────────────────────────────────────────────────

interface EasyNegativeConfig {
    /** Absolute path to the directory containing training sample JSONL files */
    trainingSamplesDir: string;
    /** Minimum rank (inclusive) for easy negative selection */
    minTopK: number;
    /** Maximum rank (inclusive) for easy negative selection */
    maxTopK: number;
    /** Number of easy negatives to select per sample */
    numNegatives: number;
}

// ── Config template ───────────────────────────────────────────────────

const CONFIG_TEMPLATE = `{
    "trainingSamplesDir": "",
    "minTopK": 500,
    "maxTopK": 2000,
    "numNegatives": 10
}
`;

// ── Config parsing ────────────────────────────────────────────────────

function parseConfig(raw: string): EasyNegativeConfig {
    const config: EasyNegativeConfig = JSON.parse(raw);

    if (!config.trainingSamplesDir) {
        throw new Error('trainingSamplesDir must not be empty');
    }
    if (!Number.isInteger(config.minTopK) || config.minTopK < 1) {
        throw new Error('minTopK must be a positive integer');
    }
    if (!Number.isInteger(config.maxTopK) || config.maxTopK < 1) {
        throw new Error('maxTopK must be a positive integer');
    }
    if (config.maxTopK <= config.minTopK) {
        throw new Error('maxTopK must be greater than minTopK');
    }
    if (!Number.isInteger(config.numNegatives) || config.numNegatives < 1) {
        throw new Error('numNegatives must be a positive integer');
    }

    return config;
}

// ── File discovery ────────────────────────────────────────────────────

/**
 * Recursively find all JSONL files in a directory.
 */
async function findJsonlFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    const entries = await fs.promises.readdir(dir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (path.extname(entry.name).toLowerCase() !== '.jsonl') continue;
        results.push(path.join(entry.parentPath || dir, entry.name));
    }
    return results;
}

// ── JSONL I/O ─────────────────────────────────────────────────────────

function parseJsonlSamples(content: string, filePath: string): TrainingSample[] {
    const lines = content.split('\n').filter(line => line.trim());
    return lines.map((line, i) => {
        try {
            return JSON.parse(line) as TrainingSample;
        } catch {
            throw new Error(`Invalid JSON on line ${i + 1} of ${filePath}`);
        }
    });
}

function serializeJsonlSamples(samples: TrainingSample[]): string {
    return samples.map(s => JSON.stringify(s)).join('\n') + '\n';
}

// ── Easy negative selection ───────────────────────────────────────────

/**
 * Get the directory + basename (without extension) for a file path.
 * Used to identify file groups that should be excluded.
 */
function getFileGroupKey(filePath: string): string {
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath, path.extname(filePath));
    return path.join(dir, baseName).toLowerCase();
}

/**
 * Randomly select `count` items from an array using Fisher-Yates partial shuffle.
 */
function randomSample<T>(items: T[], count: number): T[] {
    const arr = items.slice();
    const n = Math.min(count, arr.length);
    for (let i = 0; i < n; i++) {
        const j = i + Math.floor(Math.random() * (arr.length - i));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, n);
}

/**
 * Select easy negatives for a single training sample.
 * Searches embeddings up to maxTopK, takes results in the range
 * [minTopK, maxTopK] (1-based inclusive), filters out results that
 * share the same directory + basename as the positive, then randomly
 * picks numNegatives from the remainder.
 */
async function selectEasyNegatives(
    sample: TrainingSample,
    contentIndex: ContentIndex,
    config: EasyNegativeConfig,
): Promise<ChunkRef[]> {
    const searchResults = await contentIndex.searchEmbeddings(sample.query, config.maxTopK);

    // Slice to the desired range (convert 1-based inclusive to 0-based)
    const rangeResults = searchResults.slice(config.minTopK - 1, config.maxTopK);

    // Exclude results sharing the same directory + basename as the positive
    const positiveGroupKey = getFileGroupKey(sample.positive.filePath);
    const candidates = rangeResults.filter(r =>
        getFileGroupKey(r.filePath) !== positiveGroupKey
    );

    // Randomly select numNegatives from the candidates
    const selected = randomSample(candidates, config.numNegatives);

    return selected.map(r => ({
        filePath: r.filePath,
        startLine: r.startLine,
        endLine: r.endLine,
    }));
}

// ── File processing ───────────────────────────────────────────────────

/**
 * Process a single JSONL file: update easy negatives for all samples
 * and overwrite the file.
 */
async function processFile(
    filePath: string,
    contentIndex: ContentIndex,
    config: EasyNegativeConfig,
    token: vscode.CancellationToken,
): Promise<{ samples: number }> {
    const content = await fs.promises.readFile(filePath, 'utf8');
    const samples = parseJsonlSamples(content, filePath);

    for (const sample of samples) {
        if (token.isCancellationRequested) break;
        sample.easyNegatives = await selectEasyNegatives(sample, contentIndex, config);
    }

    if (!token.isCancellationRequested) {
        await fs.promises.writeFile(filePath, serializeJsonlSamples(samples), 'utf8');
    }

    return { samples: samples.length };
}

// ── Main command ────────────────────────────────────────────────────

export class UpdatePerFileEmbeddingTrainingDataEasyNegativesCommand {
    public readonly id = 'vscToolbox.updatePerFileEmbeddingTrainingDataEasyNegatives';
    public readonly title = 'VSC Toolbox: Update Per-File Embedding Training Data Easy Negatives';

    constructor(private context: vscode.ExtensionContext) { }

    async execute(): Promise<void> {
        // Step 1: Prompt user for config file
        const configUri = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'Easy Negative Config': ['json'] },
            title: 'Select Easy Negative Selection Config File',
        });

        if (!configUri || configUri.length === 0) {
            const doc = await vscode.workspace.openTextDocument({
                content: CONFIG_TEMPLATE,
                language: 'json',
            });
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage(
                'Fill in the configuration and save it, then run this command again.'
            );
            return;
        }

        // Step 2: Parse config
        let config: EasyNegativeConfig;
        try {
            const raw = await fs.promises.readFile(configUri[0].fsPath, 'utf8');
            config = parseConfig(raw);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to parse config: ${err.message}`);
            return;
        }

        // Step 3: Discover JSONL files
        let jsonlFiles: string[];
        try {
            jsonlFiles = await findJsonlFiles(config.trainingSamplesDir);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to scan directory: ${err.message}`);
            return;
        }

        if (jsonlFiles.length === 0) {
            vscode.window.showWarningMessage('No JSONL files found in the training samples directory');
            return;
        }

        log(`Easy negatives: Found ${jsonlFiles.length} JSONL files in ${config.trainingSamplesDir}`);

        // Step 4: Process each file with progress
        const contentIndex = ContentIndex.getInstance();
        let totalFiles = 0;
        let totalSamples = 0;
        let errors = 0;

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'VSC Toolbox: Updating Easy Negatives',
                cancellable: true,
            },
            async (progress, token) => {
                for (let i = 0; i < jsonlFiles.length; i++) {
                    if (token.isCancellationRequested) break;

                    progress.report({
                        increment: (1 / jsonlFiles.length) * 100,
                        message: `${i + 1}/${jsonlFiles.length} files (${totalSamples} samples, ${errors} errors)`,
                    });

                    try {
                        const result = await processFile(jsonlFiles[i], contentIndex, config, token);
                        totalSamples += result.samples;
                        totalFiles++;
                    } catch (err) {
                        errors++;
                        log(`Easy negatives: Error processing ${jsonlFiles[i]}: ${err}`);
                    }
                }
            },
        );

        const message = `Easy negatives updated: ${totalSamples} samples across ${totalFiles} files. ${errors} errors.`;
        log(`Easy negatives: ${message}`);
        vscode.window.showInformationMessage(message);
    }
}
