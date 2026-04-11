// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import picomatch from 'picomatch';
import {
    AgentTool,
    ALL_AGENT_TOOLS,
    getModel,
    sendLanguageModelRequest,
} from '../common/languageModelUtils';
import { ContentIndex, NearestEmbeddingResult } from '../common/index';
import { ScopedFileCache } from '../common/scopedFileCache';
import { log } from '../common/logger';
import { createMarkdownCodeBlock } from '../common/markdownUtils';

// ── Types ─────────────────────────────────────────────────────────────

/** Training data generation configuration (parsed from frontmatter JSON) */
interface TrainingConfig {
    /** Absolute path to the directory where output JSONL files are written */
    outputDir: string;
    /** Directories to walk for source files */
    rootDirs: string[];
    /** File extensions to include (e.g., [".cc", ".h"]) */
    fileExtensions: string[];
    /** Glob patterns to exclude (e.g., ["*_test.*", "mock_*"]) */
    excludePatterns: string[];
    /** Language model ID to use for generation */
    modelId: string;
    /** Maximum number of concurrent file groups to process */
    concurrency: number;
    /** Seconds to wait between dispatching batches */
    delayBetweenBatches: number;
    /** Maximum number of hard negatives to include with each query */
    maxHardNegatives: number;
    /** Number of easy negatives to generate per query */
    numEasyNegatives: number;
    /** Language model tools to enable during Phase 1 (query generation) */
    phase1Tools: AgentTool[];
    /** Language model tools to enable during Phase 2 (hard negative identification) */
    phase2Tools: AgentTool[];
    /** File names to debug */
    fileNamesToDebug: string[];
}

/** Parsed config file with both structured config and prompt template */
interface ParsedConfigFile {
    config: TrainingConfig;
    phase1PromptTemplate: string;
    phase2PromptTemplate: string;
}

/** A single training sample as returned by the LLM */
interface Phase1Sample {
    query: string;
    queryType: string;
    filePath: string;
    startLine: number;
    endLine: number;
}

/** A chunk reference using line numbers (content extracted programmatically) */
interface ChunkRef {
    /** Absolute file path */
    filePath: string;
    /** 1-based start line (inclusive) */
    startLine: number;
    /** 1-based end line (inclusive) */
    endLine: number;
}

/** A training sample with content resolved from the actual file */
interface ResolvedTrainingSample {
    query: string;
    queryType: string;
    positive: ChunkRef;
    hardNegatives: ChunkRef[];
    easyNegatives: ChunkRef[];  // content resolved at training time
}

/** A group of files with the same basename in the same directory */
interface FileGroup {
    /** Output JSONL path for this group */
    outputPath: string;
    /** All files in the group (e.g., [foo.cc, foo.h]) */
    files: string[];
}

// ── Config template ───────────────────────────────────────────────────

const CONFIG_TEMPLATE = `---
{
    "outputDir": "",
    "rootDirs": [],
    "fileExtensions": [
        ".c",
        ".cc",
        ".cpp",
        ".h",
        ".idl"
    ],
    "excludePatterns": [
        "**/*test*",
        "**/*unittest*",
        "**/*browsertest*",
        "**/*mojom*",
        "**/*mock_*",
        "**/*fuzz*"
    ],
    "modelId": "",
    "concurrency": 3,
    "delayBetweenBatches": 20,
    "maxHardNegatives": 5,
    "numEasyNegatives": 10,
    "phase1Tools": [],
    "phase2Tools": [],
    "fileNamesToDebug": []
}
---
# Phase 1: Generate Queries with Positive Samples

You are generating training data for fine-tuning an embedding model used for code search.

## Context

Add your custom context here. Describe the codebase, its conventions, and what
kind of search queries to focus on.

## Source Files

The following files have been provided for you to analyze:

{{FILE_LIST}}

{{FILE_BLOCKS}}

## Task

Generate as many diverse search queries as the code warrants, up to a maximum
of 50. Small files with few functions may only need 5-10 queries.
Larger files with big classes and methods should aim closer to the maximum.
Do not pad with low-quality or repetitive queries to reach the limit.

For each query, identify one **positive** code region: the lines that
directly answer the query.

### Query Types

Include a mix of these query types, varying from broad to specific.
Each query must be at least 8 words long. Most queries (~70%) should be natural
language descriptions of what the code does, as if the developer does not yet
know which class or function implements the behavior. The remaining ~30% can
include specific class or method names for symbol-based lookups.

- **conceptual**: "how does a navigation get committed after all throttles approve",
    "what decides whether a page can be stored in the back-forward cache",
    "code responsible for managing the lifecycle of a browser tab",
    "Where is the back forward cache implemented",
    "Where is the media foundation cdm created for use in the encrypted media pipeline".
    When applicable, queries should use general programming terms for
    codebase-specific patterns (e.g., "mutex lock" for code using base::Lock,
    "callback" for base::BindOnce, "IPC message" for mojo::Receiver).

- **symbol**: "EvictFrames method in the back forward cache implementation",
    "BeginNavigation entry point for starting a new page load"

- **behavioral**: "what happens when a redirect is received during page load",
    "code that runs when a content security policy blocks an inline script",
    "implementation that handles decoding encrypted media content from a stream"

- **debugging**: "where could the navigation commit fail if the renderer process crashes mid-request",
    "potential null pointer when the URL loader is destroyed before the response completes"

- **feature-level**: Think about what larger feature, subsystem, or workflow this
    code participates in. Generate queries that describe the feature's behavior at a
    high level — queries that would be relevant to ANY file involved in that feature,
    not just this one. Example: "how does the encrypted media pipeline determine
    which key systems are supported and what capabilities they have"

### Rules

- Each positive MUST reference one of the provided files.
- Line numbers must be 1-based and refer to actual lines in the file.
- Keep line ranges focused — typically 10-50 lines covering a meaningful code
  unit (a function, a method, a struct definition, etc.).

### Output Format

Output the marker ===JSON_START=== on its own line immediately before the JSON array.
Return ONLY a JSON array (no markdown fences, no commentary) of objects with
this exact schema:

[
  {
    "query": "search query text",
    "queryType": "conceptual",
    "filePath": "absolute file path",
    "startLine": 100,
    "endLine": 120
  }
]

# Phase 2: Identify Irrelevant Search Results

You are reviewing search results for accuracy. A developer searched for code
using the query below and found the correct answer. Your job is to check the
other search results and identify which ones have **nothing to do** with the query.

## Query

\`\`\`
{{QUERY}}
\`\`\`

## Correct Answer

The following code is the correct answer to the query:

{{POSITIVE_CODE}}

## Search Results to Review

The following code snippets were also returned by the search. Each result has
a marker like \`<<RESULT_001>>\` in its heading.

{{SEARCH_RESULTS}}

## Task

Review each \`<<RESULT_xxx>>\` section and determine whether it is **relevant**
or **irrelevant** to the query.

A result is **irrelevant** if it does NOT:
- Implement, define, or contain what the query is looking for
- Call, invoke, or directly depend on the code the query targets
- Get called by or provide functionality to the code the query targets
- Define types, constants, or data structures used by that code
- Handle errors or edge cases related to that code

A result IS relevant (do NOT include it) if it:
- Implements any part of what the query describes
- Is a caller, wrapper, or delegate of the correct answer
- Defines interfaces or base classes that the correct answer implements
- Is part of the same feature or workflow as the correct answer

When in doubt, consider the result relevant and do NOT include it.

### Output Format

Output the marker ===JSON_START=== on its own line immediately before the JSON array.
Return ONLY a JSON array of result marker strings for the **irrelevant** results,
ordered from most obviously irrelevant to least obviously irrelevant.

Example:

===JSON_START===
["RESULT_012", "RESULT_003", "RESULT_027"]

If all results are relevant to the query, return an empty array:

===JSON_START===
[]
`;

// ── Config parsing ────────────────────────────────────────────────────

function parseConfigFile(raw: string): ParsedConfigFile {
    const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!match) {
        throw new Error('Invalid config file format. Expected JSON between --- fences.');
    }

    const config: TrainingConfig = JSON.parse(match[1]);
    const body = match[2].trim();

    // Split body into Phase 1 and Phase 2 templates on the "# Phase 2" heading
    const phaseMatch = body.match(/^([\s\S]*?)\n# Phase 2:[^\n]*\n([\s\S]*)$/m);
    if (!phaseMatch) {
        throw new Error('Config file must contain a "# Phase 2:" heading to separate the two prompt phases.');
    }

    // Remove the "# Phase 1:" heading line from the phase 1 template
    const phase1PromptTemplate = phaseMatch[1].replace(/^# Phase 1:[^\n]*\n/, '').trim();
    const phase2PromptTemplate = phaseMatch[2].trim();

    // Validate required fields
    const required: (keyof TrainingConfig)[] = [
        'outputDir', 'rootDirs', 'fileExtensions', 'excludePatterns',
        'modelId', 'concurrency', 'delayBetweenBatches',
    ];
    for (const field of required) {
        if (config[field] === undefined || config[field] === null) {
            throw new Error(`Missing required config field: "${field}"`);
        }
    }

    if (!config.outputDir) {
        throw new Error('outputDir must not be empty');
    }
    if (config.rootDirs.length === 0) {
        throw new Error('rootDirs must contain at least one directory');
    }
    if (!config.modelId) {
        throw new Error('modelId must not be empty');
    }
    if (config.concurrency < 1) {
        throw new Error('concurrency must be at least 1');
    }
    if (config.delayBetweenBatches < 0) {
        throw new Error('delayBetweenBatches must not be negative');
    }
    if (!phase1PromptTemplate) {
        throw new Error('Phase 1 prompt template must not be empty');
    }
    if (!phase2PromptTemplate) {
        throw new Error('Phase 2 prompt template must not be empty');
    }

    // Default optional fields
    if (config.maxHardNegatives === undefined) {
        config.maxHardNegatives = 5;
    }
    if (config.numEasyNegatives === undefined) {
        config.numEasyNegatives = 10;
    }
    if (config.phase1Tools === undefined) {
        config.phase1Tools = [];
    }
    if (config.phase2Tools === undefined) {
        config.phase2Tools = [];
    }
    for (const tool of config.phase1Tools) {
        if (!ALL_AGENT_TOOLS.includes(tool)) {
            throw new Error(`Invalid phase1Tools value: "${tool}". Valid values: ${ALL_AGENT_TOOLS.join(', ')}`);
        }
    }
    for (const tool of config.phase2Tools) {
        if (!ALL_AGENT_TOOLS.includes(tool)) {
            throw new Error(`Invalid phase2Tools value: "${tool}". Valid values: ${ALL_AGENT_TOOLS.join(', ')}`);
        }
    }
    if (config.fileNamesToDebug === undefined) {
        config.fileNamesToDebug = [];
    }

    return { config, phase1PromptTemplate, phase2PromptTemplate };
}

// ── File discovery ────────────────────────────────────────────────────

/**
 * Recursively find all files matching the given extensions in a directory,
 * excluding files that match any exclude pattern.
 */
async function findFiles(
    rootDir: string,
    extensions: string[],
    excludePatterns: string[],
): Promise<string[]> {
    const extensionsSet = new Set(extensions.map(e => e.toLowerCase()));
    const excludeMatchers = excludePatterns.map(p =>
        picomatch(p, { windows: true, nocase: true })
    );

    const results: string[] = [];

    try {
        const entries = await fs.promises.readdir(rootDir, { withFileTypes: true, recursive: true });
        for (const entry of entries) {
            if (!entry.isFile()) continue;

            // Ignore files that don't match any extension
            const extension = path.extname(entry.name).toLowerCase();
            if (!extensionsSet.has(extension)) continue;

            const fullPath = path.join(entry.parentPath || rootDir, entry.name);

            // Ignore paths that match any exclude pattern
            if (excludeMatchers.some(m => m(fullPath))) continue;

            results.push(fullPath);
        }
    } catch (err) {
        log(`Training: Failed to scan directory ${rootDir}: ${err}`);
    }

    return results;
}

/**
 * Group files by basename (without extension) in the same directory
 * and compute the output path for each group.
 */
function getFileGroups(filePaths: string[], outputDir: string): FileGroup[] {
    const groups = new Map<string, string[]>();

    for (const filePath of filePaths) {
        // Get the full path without extension as the key
        // (e.g., c:\src\foo\bar\baz for c:\src\foo\bar\baz.cc)
        const dir = path.dirname(filePath);
        const baseName = path.basename(filePath, path.extname(filePath));
        const key = path.join(dir, baseName).toLowerCase();

        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key)!.push(filePath);
    }

    const result: FileGroup[] = [];
    for (const [key, files] of groups.entries()) {
        files.sort();
        result.push({
            outputPath: computeOutputPath(outputDir, key),
            files,
        });
    }

    return result;
}

// ── Output path computation ─────────────────────────────────────────

/**
 * Compute the output JSONL path for a given source file.
 * Uses the same hashing scheme as FileRef for consistency.
 * The extension is stripped from the file name since the output
 * represents a group of files with the same basename.
 */
function computeOutputPath(outputDir: string, sourceFilePath: string): string {
    const hash = crypto.createHash('sha256')
        .update(sourceFilePath)
        .digest('hex')
        .substring(0, 16)
        .toUpperCase();
    const baseName = path.basename(sourceFilePath, path.extname(sourceFilePath));
    const firstChar = baseName[0]?.toLowerCase() ?? '_';
    const subDir = firstChar >= 'a' && firstChar <= 'z' ? firstChar : '_';
    return path.join(outputDir, subDir, `${baseName}.${hash}.jsonl`);
}

/**
 * Check if a file group has already been processed.
 * The output file must exist, be non-empty, and contain valid JSON on every line.
 */
function isAlreadyProcessed(outputPath: string): boolean {
    try {
        const content = fs.readFileSync(outputPath, 'utf8');
        if (!content.trim()) {
            return false;
        }
        const lines = content.split('\n').filter(line => line.trim());
        for (const line of lines) {
            JSON.parse(line);
        }
        return true;
    } catch {
        return false;
    }
}

// ── File content formatting ─────────────────────────────────────────

/**
 * Format a file's content with line numbers for the LLM prompt.
 */
function formatFileWithLineNumbers(filePath: string, lines: string[]): string {
    const numbered = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
    return `## File: ${filePath}\n\n\`\`\`\n${numbered}\n\`\`\``;
}

/**
 * Build the prompt by replacing {{FILE_LIST}} and {{FILE_BLOCKS}} placeholders
 * in the user's prompt template.
 */
function buildPrompt(
    promptTemplate: string,
    fileContents: { filePath: string; lines: string[] }[],
): string {
    const fileBlocks = fileContents
        .map(f => formatFileWithLineNumbers(f.filePath, f.lines))
        .join('\n\n');
    const filePathList = fileContents.map(f => `- ${f.filePath}`).join('\n');

    return promptTemplate
        .replace('{{FILE_LIST}}', filePathList)
        .replace('{{FILE_BLOCKS}}', fileBlocks);
}

// ── Response parsing ────────────────────────────────────────────────

/**
 * Parse JSON from the LLM response, handling markdown code fences.
 */
function parseJsonResponse(response: string): unknown {
    let text = response.trim();
    // Strip everything before the ===JSON_START=== marker if present
    const marker = '===JSON_START===';
    const markerIndex = text.indexOf(marker);
    if (markerIndex !== -1) {
        text = text.substring(markerIndex + marker.length).trim();
    }
    // Strip markdown code fences if present
    if (text.startsWith('```')) {
        const firstNewline = text.indexOf('\n');
        const lastFence = text.lastIndexOf('```');
        if (lastFence > firstNewline) {
            text = text.substring(firstNewline + 1, lastFence).trim();
        }
    }
    return JSON.parse(text);
}

/**
 * Validate and filter Phase 1 samples from LLM output.
 * Returns only samples whose file path matches one of the input files
 * and whose line range is valid.
 */
function validatePhase1Samples(
    raw: unknown,
    inputFilePaths: Set<string>,
    fileLineCountMap: Map<string, number>,
): { valid: Phase1Sample[]; discarded: number } {
    if (!Array.isArray(raw)) {
        throw new Error('LLM response is not a JSON array');
    }

    const valid: Phase1Sample[] = [];
    let discarded = 0;

    for (const item of raw) {
        const sample = item as Phase1Sample;

        // Validate required fields
        if (!sample.query || !sample.queryType || !sample.filePath
            || !sample.startLine || !sample.endLine) {
            discarded++;
            continue;
        }

        // Check file path matches an input file
        if (!inputFilePaths.has(sample.filePath)) {
            log(`Training: Discarded sample — file path "${sample.filePath}" not in input files`);
            discarded++;
            continue;
        }

        // Validate line numbers
        const lineCount = fileLineCountMap.get(sample.filePath);
        if (lineCount === undefined) {
            discarded++;
            continue;
        }
        if (sample.startLine < 1 || sample.endLine > lineCount
            || sample.startLine > sample.endLine) {
            log(`Training: Discarded sample — invalid line range ${sample.startLine}-${sample.endLine} (file has ${lineCount} lines)`);
            discarded++;
            continue;
        }

        // Validate line range isn't too large
        if (sample.endLine - sample.startLine > 400) {
            log(`Training: Discarded sample — line range too large (${sample.endLine - sample.startLine} lines)`);
            discarded++;
            continue;
        }

        valid.push(sample);
    }

    return { valid, discarded };
}

// ── File writing ────────────────────────────────────────────────────

/**
 * Write samples to a JSONL file. If the process crashes mid-write,
 * isAlreadyProcessed() will detect the invalid JSON and reprocess.
 */
async function writeOutput(
    outputPath: string,
    samples: ResolvedTrainingSample[],
): Promise<void> {
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    const lines = samples.map(s => JSON.stringify(s));
    await fs.promises.writeFile(outputPath, lines.join('\n') + '\n', 'utf8');
}

/**
 * Write a human-readable debug file with hydrated content for all chunks.
 * The debug file is written next to the output file with a ".debug.md"
 * extension (e.g., foo.ABC123.debug.md).
 */
async function writeDebugOutput(
    outputPath: string,
    samples: ResolvedTrainingSample[],
    fileCache: ScopedFileCache,
): Promise<void> {
    const ext = path.extname(outputPath);
    const base = outputPath.slice(0, -ext.length);
    const debugPath = `${base}.debug.md`;

    const sections: string[] = [];

    for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        let md = `# Sample ${i + 1}: ${sample.query}\n\n`;
        md += `**Query Type:** ${sample.queryType}\n\n`;

        // Positive
        md += `## Positive\n\n`;
        md += await formatChunkRefAsMarkdown(sample.positive, fileCache);

        // Hard negatives
        if (sample.hardNegatives.length > 0) {
            md += `## Hard Negatives (${sample.hardNegatives.length})\n\n`;
            for (let j = 0; j < sample.hardNegatives.length; j++) {
                md += `### Hard Negative ${j + 1}\n\n`;
                md += await formatChunkRefAsMarkdown(sample.hardNegatives[j], fileCache);
            }
        }

        // Easy negatives
        if (sample.easyNegatives.length > 0) {
            md += `## Easy Negatives (${sample.easyNegatives.length})\n\n`;
            for (let j = 0; j < sample.easyNegatives.length; j++) {
                md += `### Easy Negative ${j + 1}\n\n`;
                md += await formatChunkRefAsMarkdown(sample.easyNegatives[j], fileCache);
            }
        }

        sections.push(md);
    }

    await fs.promises.writeFile(debugPath, sections.join('\n---\n\n') + '\n', 'utf8');
    log(`Training: Debug output written to ${debugPath}`);
}

/**
 * Format a ChunkRef as a markdown section with hydrated file content.
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

// ── Delay helper ────────────────────────────────────────────────────

function delay(seconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

// ── File group processing ───────────────────────────────────────────

/**
 * Process all pending file groups using a worker pool with progress reporting.
 * Spawns N workers (config.concurrency) that each pull the next pending
 * group from a shared index counter. As soon as one group finishes, the
 * worker immediately picks up the next.
 */
async function processAllGroups(
    pendingGroups: FileGroup[],
    config: TrainingConfig,
    phase1Template: string,
    phase2Template: string,
    model: vscode.LanguageModelChat,
    progress: vscode.Progress<{ increment?: number; message?: string }>,
    token: vscode.CancellationToken,
): Promise<void> {
    let completed = 0;
    let totalSamples = 0;
    let totalDiscarded = 0;
    let errors = 0;
    const startTime = Date.now();

    const fileCache = new ScopedFileCache();

    // Shared index counter — each worker atomically grabs the next group.
    // Safe without locks because JS is single-threaded (no concurrent mutation).
    let nextIndex = 0;

    function reportProgress(): void {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = completed / elapsed;
        const remaining = (pendingGroups.length - completed) / rate;

        progress.report({
            increment: (1 / pendingGroups.length) * 100,
            message: `${completed}/${pendingGroups.length} groups (${totalSamples} samples, ${errors} errors, ~${Math.ceil(remaining / 60)}m remaining)`,
        });
    }

    // Each worker loops pulling the next group until none remain
    async function worker(): Promise<void> {
        while (!token.isCancellationRequested) {
            const index = nextIndex++;
            if (index >= pendingGroups.length) break;

            try {
                const result = await processFileGroup(
                    pendingGroups[index], config, phase1Template,
                    phase2Template, model, fileCache, token
                );
                totalSamples += result.samples;
                totalDiscarded += result.discarded;
            } catch (err) {
                errors++;
                log(`Training: Error — ${err}`);
            }

            completed++;
            reportProgress();

            // Periodically clear the file cache to limit memory usage
            if (completed % 100 === 0) {
                fileCache.clear();
            }
        }
    }

    // Spawn N workers — they all share the same index counter
    const workers: Promise<void>[] = [];
    for (let i = 0; i < config.concurrency; i++) {
        workers.push(worker());
    }

    await Promise.all(workers);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const message = token.isCancellationRequested
        ? `Training data generation cancelled. ${completed}/${pendingGroups.length} groups processed, ${totalSamples} samples generated.`
        : `Training data generation complete. ${totalSamples} samples from ${completed} groups in ${elapsed}s. ${totalDiscarded} discarded, ${errors} errors.`;

    log(`Training: ${message}`);
    vscode.window.showInformationMessage(message);
}

/**
 * Process a single file group through Phase 1 (query generation),
 * Phase 2 (hard negative identification), and easy negative selection.
 */
async function processFileGroup(
    group: FileGroup,
    config: TrainingConfig,
    phase1Template: string,
    phase2Template: string,
    model: vscode.LanguageModelChat,
    fileCache: ScopedFileCache,
    token: vscode.CancellationToken,
): Promise<{ samples: number; discarded: number }> {
    // Phase 1: Generate queries with positive samples
    const { samples: validSamples, discarded } = await runPhase1(
        group, phase1Template, model, fileCache, token, config.phase1Tools
    );

    if (validSamples.length === 0 || token.isCancellationRequested) {
        log(`Training: ${group.files[0]} — 0 samples, ${discarded} discarded`);
        return { samples: 0, discarded };
    }

    // Phase 2: Find hard/easy negatives for each query
    const finalSamples = await runPhase2(
        validSamples, config, phase2Template, model, fileCache, token,
    );

    if (finalSamples.length > 0 && !token.isCancellationRequested) {
        await writeOutput(group.outputPath, finalSamples);

        // Write debug output if any file in the group matches fileNamesToDebug
        if (config.fileNamesToDebug.length > 0) {
            const debugNames = new Set(config.fileNamesToDebug.map(n => n.toLowerCase()));
            const shouldDebug = group.files.some(f =>
                debugNames.has(path.basename(f).toLowerCase())
            );
            if (shouldDebug) {
                await writeDebugOutput(group.outputPath, finalSamples, fileCache);
            }
        }
    }

    log(`Training: ${group.files[0]} — ${finalSamples.length} samples, ${discarded} discarded`);

    return {
        samples: finalSamples.length,
        discarded,
    };
}

/**
 * Phase 1: Call the LLM to generate (query, positive) pairs from source files.
 * Returns validated samples with non-empty positive content.
 */
async function runPhase1(
    group: FileGroup,
    phase1Template: string,
    model: vscode.LanguageModelChat,
    fileCache: ScopedFileCache,
    token: vscode.CancellationToken,
    phase1Tools: AgentTool[],
): Promise<{ samples: Phase1Sample[]; discarded: number }> {
    // Read all files in the group (loads into fileCache for reuse)
    const fileContents: { filePath: string; lines: string[] }[] = [];
    const fileLineCountMap = new Map<string, number>();
    const inputFilePaths = new Set<string>();

    for (const filePath of group.files) {
        // No try/catch — all files in the group must be readable so the
        // LLM has complete context when generating queries.
        const lines = await fileCache.getLines(filePath);
        fileContents.push({ filePath, lines });
        fileLineCountMap.set(filePath, lines.length);
        inputFilePaths.add(filePath);
    }

    if (fileContents.length === 0) {
        return { samples: [], discarded: 0 };
    }

    const phase1Prompt = buildPrompt(phase1Template, fileContents);

    let phase1Response: string;
    try {
        phase1Response = await callWithRetry(
            model, phase1Prompt, fileCache, token, phase1Tools
        );
    } catch (err: any) {
        throw new Error(`Phase 1 LLM call failed for ${group.files[0]}: ${err.message}`);
    }

    let rawPhase1: unknown;
    try {
        rawPhase1 = parseJsonResponse(phase1Response);
    } catch (err: any) {
        log(`Training: Failed to parse Phase 1 response for ${group.files[0]}: ${err.message}`);
        log(`Training: Raw response: ${phase1Response.substring(0, 500)}`);
        throw new Error(`Phase 1 JSON parse error for ${group.files[0]}`);
    }

    const { valid: phase1Samples, discarded } = validatePhase1Samples(
        rawPhase1, inputFilePaths, fileLineCountMap
    );

    // Filter out samples whose positive range yields empty content
    const samples: Phase1Sample[] = [];
    for (const sample of phase1Samples) {
        try {
            const lines = await fileCache.getLines(sample.filePath);
            const content = lines.slice(sample.startLine - 1, sample.endLine).join('\n');
            if (content.trim().length > 0) {
                samples.push(sample);
            }
        } catch {
            // Skip samples whose files can't be read
        }
    }

    return {
        samples,
        discarded: discarded + (phase1Samples.length - samples.length),
    };
}

/**
 * Phase 2: For each (query, positive) pair, find hard negatives via
 * LLM-based relevance classification and easy negatives via negated
 * vector search.
 */
async function runPhase2(
    validSamples: Phase1Sample[],
    config: TrainingConfig,
    phase2Template: string,
    model: vscode.LanguageModelChat,
    fileCache: ScopedFileCache,
    token: vscode.CancellationToken,
): Promise<ResolvedTrainingSample[]> {
    const contentIndex = ContentIndex.getInstance();
    const finalSamples: ResolvedTrainingSample[] = [];
    const topK = vscode.workspace.getConfiguration('vscToolbox')
        .get<number>('embeddingSearchTopK', 30);
    const batchSize = 100;

    for (let i = 0; i < validSamples.length && !token.isCancellationRequested; i += batchSize) {
        const batch = validSamples.slice(i, i + batchSize);

        const batchPromises = batch.map(sample => processSingleSample(
            sample, config, phase2Template, model, fileCache,
            contentIndex, topK, token,
        ));

        // Uses Promise.all (not allSettled) so that any single sample
        // failure immediately rejects the entire batch. This prevents
        // writing partial/incomplete results to disk. The error
        // propagates to processFileGroup which skips the write, and
        // processAllGroups (which uses allSettled) records it as a
        // group-level error for retry on the next run. In-flight
        // sibling promises continue running to completion in the
        // background but their results are discarded.
        const results = await Promise.all(batchPromises);
        finalSamples.push(...results);
    }

    return finalSamples;
}

/**
 * Process a single (query, positive) pair: find hard negatives via
 * LLM classification and easy negatives via negated vector search.
 */
async function processSingleSample(
    sample: Phase1Sample,
    config: TrainingConfig,
    phase2Template: string,
    model: vscode.LanguageModelChat,
    fileCache: ScopedFileCache,
    contentIndex: ContentIndex,
    topK: number,
    token: vscode.CancellationToken,
): Promise<ResolvedTrainingSample> {
    const resolved: ResolvedTrainingSample = {
        query: sample.query,
        queryType: sample.queryType,
        positive: {
            filePath: sample.filePath,
            startLine: sample.startLine,
            endLine: sample.endLine,
        },
        hardNegatives: [],
        easyNegatives: [],
    };

    // Search for hard negative candidates (top results from embedding search).
    // No try/catch — a failure here means the embedding index is broken and
    // the entire file group should be skipped rather than producing incomplete data.
    const searchResults = (await contentIndex.searchEmbeddings(sample.query, topK))
        .filter(r =>
            r.filePath !== sample.filePath
            || r.endLine < sample.startLine
            || r.startLine > sample.endLine
        );

    if (searchResults.length > 0) {
        // Format search results with IDs for the LLM
        const searchResultsMarkdown = await formatSearchResultsWithIds(
            searchResults, fileCache,
        );

        // Build the positive code block for context
        const posLines = await fileCache.getLines(sample.filePath);
        const posContent = posLines.slice(sample.startLine - 1, sample.endLine);
        const posCodeBlock = `**${sample.filePath}** (lines ${sample.startLine}-${sample.endLine}):\n\n\`\`\`\n${posContent.join('\n')}\n\`\`\``;

        // Build Phase 2 prompt
        const phase2Prompt = phase2Template
            .replace('{{QUERY}}', sample.query)
            .replace('{{POSITIVE_CODE}}', posCodeBlock)
            .replace('{{SEARCH_RESULTS}}', searchResultsMarkdown);

        // No try/catch — LLM or parse failures should fail the entire
        // file group to avoid writing incomplete training data.
        const phase2Response = await callWithRetry(
            model, phase2Prompt, fileCache, token, config.phase2Tools
        );
        const irrelevantIds = parsePhase2Response(
            phase2Response, searchResults.length,
        );

        // Take up to maxHardNegatives, preserving the LLM's
        // ordering (most obviously irrelevant first)
        const hardNegCandidates = irrelevantIds
            .filter(idx => idx >= 0 && idx < searchResults.length)
            .map(idx => searchResults[idx])
            .slice(0, config.maxHardNegatives);

        resolved.hardNegatives = hardNegCandidates.map(r => ({
            filePath: r.filePath,
            startLine: r.startLine,
            endLine: r.endLine,
        }));
    }

    // Easy negatives: negated vector search.
    // No try/catch — incomplete training data should not be written.
    if (config.numEasyNegatives > 0) {
        const easyResults = await contentIndex.searchEmbeddings(
            sample.query, config.numEasyNegatives, true // negated
        );
        resolved.easyNegatives = easyResults.map(r => ({
            filePath: r.filePath,
            startLine: r.startLine,
            endLine: r.endLine,
        }));
    }

    return resolved;
}

/**
 * Format search results as markdown with <<RESULT_xxx>> ID markers.
 * Uses i*3 spaced numbering (RESULT_000, RESULT_003, ...) to reduce
 * LLM off-by-one errors when referencing results.
 */
async function formatSearchResultsWithIds(
    results: NearestEmbeddingResult[],
    fileCache: ScopedFileCache,
): Promise<string> {
    let markdown = '';

    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const id = `RESULT_${String(i * 3).padStart(3, '0')}`;

        let lines: string[];
        try {
            const allLines = await fileCache.getLines(r.filePath);
            lines = allLines.slice(r.startLine - 1, r.endLine);
        } catch {
            continue;
        }

        markdown += `## <<${id}>> ${r.filePath}\n\n`;
        markdown += `Showing lines ${r.startLine} - ${r.endLine}:\n\n`;
        const range = new vscode.Range(0, 0, lines.length - 1, 0);
        const codeBlock = createMarkdownCodeBlock(lines, range, r.filePath);
        markdown += codeBlock.join('\n') + '\n\n';
    }

    return markdown;
}

/**
 * Parse the Phase 2 LLM response to extract irrelevant result indices.
 * Returns indices into the search results array, ordered from most to
 * least obviously irrelevant (as returned by the LLM).
 */
function parsePhase2Response(
    response: string,
    resultCount: number,
): number[] {
    const parsed = parseJsonResponse(response);

    if (!Array.isArray(parsed)) {
        return [];
    }

    // Build marker → index map (RESULT_000 → 0, RESULT_003 → 1, ...)
    const markerToIndex = new Map<string, number>();
    for (let i = 0; i < resultCount; i++) {
        markerToIndex.set(`RESULT_${String(i * 3).padStart(3, '0')}`, i);
    }

    const seen = new Set<number>();
    const indices: number[] = [];

    for (const marker of parsed) {
        if (typeof marker !== 'string') continue;
        const index = markerToIndex.get(marker);
        if (index !== undefined && !seen.has(index)) {
            seen.add(index);
            indices.push(index);
        }
    }

    return indices;
}

/**
 * Call the LLM with retry logic for rate limit errors.
 */
async function callWithRetry(
    model: vscode.LanguageModelChat,
    prompt: string,
    fileCache: ScopedFileCache,
    token: vscode.CancellationToken,
    enabledTools: AgentTool[] = [],
    maxRetries: number = 3,
): Promise<string> {
    const delays = [10, 30, 60]; // seconds between retries

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await sendLanguageModelRequest(
                model,
                prompt,
                token,
                100, // maxToolCalls
                fileCache,
                enabledTools,
            );
        } catch (err: any) {
            if (err instanceof vscode.LanguageModelError) {
                if (err.code === 'Blocked') {
                    if (attempt < maxRetries) {
                        const waitTime = delays[attempt] ?? 60;
                        log(`Training: Rate limited (attempt ${attempt + 1}/${maxRetries + 1}), waiting ${waitTime}s...`);
                        await delay(waitTime);
                        continue;
                    }
                    throw new Error(`Rate limited after ${maxRetries + 1} attempts`);
                }
                if (err.code === 'NoPermissions') {
                    throw new Error('No permission to use language model. User must grant access.');
                }
                if (err.code === 'NotFound') {
                    throw new Error(`Model not found: ${err.message}`);
                }
            }
            throw err;
        }
    }

    throw new Error('Unexpected: exhausted retries without returning or throwing');
}

// ── Main command ────────────────────────────────────────────────────

export class GeneratePerFileEmbeddingTrainingDataCommand {
    public readonly id = 'vscToolbox.generatePerFileEmbeddingTrainingData';
    public readonly title = 'VSC Toolbox: Generate Per-File Embedding Training Data';

    constructor(private context: vscode.ExtensionContext) { }

    async execute(): Promise<void> {
        // Step 1: Prompt user for config file
        const configUri = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'Training Config': ['txt', 'cfg', 'config'] },
            title: 'Select Training Data Generation Config File',
        });

        if (!configUri || configUri.length === 0) {
            // User cancelled — create a template
            const doc = await vscode.workspace.openTextDocument({
                content: CONFIG_TEMPLATE,
                language: 'plaintext',
            });
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage(
                'Fill in the configuration and save it, then run this command again.'
            );
            return;
        }

        // Step 2: Parse config
        let parsed: ParsedConfigFile;
        try {
            const raw = await fs.promises.readFile(configUri[0].fsPath, 'utf8');
            parsed = parseConfigFile(raw);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to parse config: ${err.message}`);
            return;
        }

        const { config, phase1PromptTemplate, phase2PromptTemplate } = parsed;

        // Step 3: Validate model
        const model = await getModel(config.modelId);
        if (!model) {
            vscode.window.showErrorMessage(`Model "${config.modelId}" not found`);
            return;
        }

        // Step 4: Discover files
        const allFiles: string[] = [];
        for (const rootDir of config.rootDirs) {
            const files = await findFiles(rootDir, config.fileExtensions, config.excludePatterns);
            for (const file of files) {
                allFiles.push(file);
            }
        }

        if (allFiles.length === 0) {
            vscode.window.showWarningMessage('No files found matching the configuration');
            return;
        }

        // Step 5: Group by basename and compute output paths
        const fileGroups = getFileGroups(allFiles, config.outputDir);

        // Step 6: Filter out already-processed groups
        const pendingGroups: FileGroup[] = [];
        for (const group of fileGroups) {
            if (isAlreadyProcessed(group.outputPath)) {
                continue;
            }
            // Clean up empty or corrupt files so they get reprocessed
            try {
                if (fs.existsSync(group.outputPath)) {
                    const stat = fs.statSync(group.outputPath);
                    if (stat.size === 0) {
                        fs.unlinkSync(group.outputPath);
                    }
                }
            } catch { /* ignore cleanup errors */ }

            pendingGroups.push(group);
        }

        const totalGroups = fileGroups.length;
        const skippedGroups = totalGroups - pendingGroups.length;

        if (pendingGroups.length === 0) {
            vscode.window.showInformationMessage(
                `All ${totalGroups} file groups already processed. Delete output files to regenerate.`
            );
            return;
        }

        log(`Training: ${totalGroups} file groups found, ${skippedGroups} already processed, ${pendingGroups.length} pending`);

        // Step 7: Process file groups with progress
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'VSC Toolbox: Generating Training Data',
                cancellable: true,
            },
            (progress, token) => processAllGroups(
                pendingGroups, config, phase1PromptTemplate,
                phase2PromptTemplate, model, progress, token,
            ),
        );
    }
}
