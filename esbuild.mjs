// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as esbuild from 'esbuild';
import { copyFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/**
 * Plugin that copies web-tree-sitter.wasm into the output directory.
 * The WASM runtime is loaded at runtime via fs, not imported as JS,
 * so esbuild can't bundle it — it must sit alongside the output.
 */
const copyWasmPlugin = {
    name: 'copy-wasm',
    setup(build) {
        build.onEnd(async () => {
            const outdir = dirname(build.initialOptions.outfile);
            await mkdir(outdir, { recursive: true });
            await copyFile(
                join('node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
                join(outdir, 'web-tree-sitter.wasm')
            );
        });
    },
};

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
// web-tree-sitter uses import.meta.url internally for createRequire() and WASM
// location, but esbuild shims import.meta as {} in CJS bundles. We inject a
// real value so the emscripten bootstrap can resolve paths correctly.
const workerConfig = {
    ...sharedOptions,
    entryPoints: ['src/common/index/workerThread.ts'],
    outfile: 'out/workerThread.js',
    define: {
        'import.meta.url': 'importMetaUrl',
    },
    banner: {
        js: 'var importMetaUrl = require("url").pathToFileURL(__filename).href;',
    },
    plugins: [copyWasmPlugin],
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
