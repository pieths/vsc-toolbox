// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const sharedOptions = {
    bundle: true,
    platform: 'node',
    target: 'es2020',
    format: 'cjs',
    sourcemap: !production,
    minify: production,
};

// Main extension bundle
const extensionConfig = {
    ...sharedOptions,
    entryPoints: ['src/extension.ts'],
    outfile: 'out/extension.js',
    external: ['vscode', '@lancedb/lancedb-win32-x64-msvc'],
};

// Worker thread — must be a separate file (loaded by new Worker())
const workerConfig = {
    ...sharedOptions,
    entryPoints: ['src/common/index/workerThread.ts'],
    outfile: 'out/workerThread.js',
};

async function main() {
    if (watch) {
        const [ctx1, ctx2] = await Promise.all([
            esbuild.context(extensionConfig),
            esbuild.context(workerConfig),
        ]);
        await Promise.all([ctx1.watch(), ctx2.watch()]);
        console.log('[watch] build started');
    } else {
        await Promise.all([
            esbuild.build(extensionConfig),
            esbuild.build(workerConfig),
        ]);
        console.log('build complete');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
