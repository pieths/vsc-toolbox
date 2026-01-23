// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import * as path from 'path';
import { CacheManager } from './cacheManager';
import { ThreadPoolManager } from './threadPool';
import { log, warn } from '../logger';

/**
 * FileWatcher monitors file system changes and updates the cache accordingly.
 * Supports watching both workspace folders and external directories.
 */
export class FileWatcher implements vscode.Disposable {
    private cacheManager: CacheManager;
    private threadPool: ThreadPoolManager;
    private includePaths: string[];
    private fileExtensions: string[];
    private disposables: vscode.Disposable[] = [];
    private watchers: vscode.FileSystemWatcher[] = [];

    /**
     * Create a new file watcher.
     *
     * @param cacheManager - Cache manager to update on file changes
     * @param threadPool - Thread pool for indexing operations
     * @param includePaths - List of directory paths to include
     * @param fileExtensions - List of file extensions to include
     */
    constructor(
        cacheManager: CacheManager,
        threadPool: ThreadPoolManager,
        includePaths: string[],
        fileExtensions: string[]) {

        this.cacheManager = cacheManager;
        this.threadPool = threadPool;
        this.includePaths = includePaths;
        this.fileExtensions = fileExtensions.map(ext => ext.toLowerCase());

        this.createWatchers();
    }

    /**
     * Create file system watchers for all include paths.
     * Creates one workspace watcher plus separate watchers for external paths.
     */
    private createWatchers(): void {
        // Dispose existing watchers and their event subscriptions
        this.cleanupWatchers();

        // Build glob pattern for file extensions
        const extPattern = this.buildExtensionPattern();

        // Always create a single workspace watcher
        const workspaceWatcher = vscode.workspace.createFileSystemWatcher(`**/*${extPattern}`);
        this.registerWatcherEvents(workspaceWatcher);
        this.watchers.push(workspaceWatcher);
        log('FileWatcher: Watching all workspace files');

        // Create additional watchers only for external paths
        for (const includePath of this.includePaths) {
            if (!this.isPathInWorkspace(includePath)) {
                this.createWatcherForExternalPath(includePath, extPattern);
            }
        }
    }

    /**
     * Build a glob pattern for file extensions.
     * @returns Glob pattern like ".{cc,h,md}" or empty string if no extensions
     */
    private buildExtensionPattern(): string {
        if (this.fileExtensions.length === 0) {
            return '';
        }

        // Remove leading dots and join with commas
        const exts = this.fileExtensions.map(ext => ext.replace(/^\./, '')).join(',');
        return `.{${exts}}`;
    }

    /**
     * Create a watcher for an external path (outside workspace).
     * Uses RelativePattern with Uri base.
     *
     * @param includePath - Directory path to watch
     * @param extPattern - Glob pattern for file extensions
     */
    private createWatcherForExternalPath(includePath: string, extPattern: string): void {
        const baseUri = vscode.Uri.file(includePath);
        const pattern = new vscode.RelativePattern(baseUri, `**/*${extPattern}`);
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        this.registerWatcherEvents(watcher);
        this.watchers.push(watcher);
        log(`FileWatcher: Watching external path: ${includePath}`);
    }

    /**
     * Check if a path is inside any workspace folder.
     *
     * @param fsPath - Filesystem path to check
     * @returns true if path is inside a workspace folder
     */
    private isPathInWorkspace(fsPath: string): boolean {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return false;
        }

        const normalizedPath = path.normalize(fsPath).toLowerCase();

        return workspaceFolders.some(folder => {
            const folderPath = path.normalize(folder.uri.fsPath).toLowerCase();
            return normalizedPath.startsWith(folderPath);
        });
    }

    /**
     * Register event handlers for a watcher.
     *
     * @param watcher - The file system watcher
     */
    private registerWatcherEvents(watcher: vscode.FileSystemWatcher): void {
        this.disposables.push(
            watcher.onDidChange(uri => this.handleChange(uri)),
            watcher.onDidCreate(uri => this.handleCreate(uri)),
            watcher.onDidDelete(uri => this.handleDelete(uri))
        );
    }

    /**
     * Check if a file path should be included based on includePaths config.
     *
     * @param filePath - Absolute file path to check
     * @returns true if file should be included
     */
    private shouldInclude(filePath: string): boolean {
        // Only include files with matching extensions
        const ext = path.extname(filePath).toLowerCase();
        if (!this.fileExtensions.includes(ext)) {
            return false;
        }

        // If no include paths specified, include all matching files
        if (this.includePaths.length === 0) {
            return true;
        }

        // Normalize and lowercase for case-insensitive comparison (Windows)
        const normalizedPath = path.normalize(filePath).toLowerCase();

        // Check if file is under any of the include paths
        return this.includePaths.some(includePath => {
            const normalizedInclude = path.normalize(includePath).toLowerCase();
            return normalizedPath.startsWith(normalizedInclude);
        });
    }

    /**
     * Handle file change event.
     * Invalidates the cache entry and rebuilds the index in the background.
     *
     * @param uri - URI of the changed file
     */
    private handleChange(uri: vscode.Uri): void {
        const filePath = uri.fsPath;

        // Skip if not in include paths
        if (!this.shouldInclude(filePath)) {
            return;
        }

        log(`FileWatcher: Changed: ${filePath}`);

        // Invalidate cache and rebuild index in background
        this.cacheManager.invalidate(filePath);
        this.rebuildIndexInBackground(filePath);
    }

    /**
     * Handle file create event.
     * Adds the file to the cache and builds its index.
     *
     * @param uri - URI of the created file
     */
    private handleCreate(uri: vscode.Uri): void {
        const filePath = uri.fsPath;

        // Skip if not in include paths
        if (!this.shouldInclude(filePath)) {
            return;
        }

        log(`FileWatcher: Created: ${filePath}`);

        // Add to cache (this will also build the index)
        this.cacheManager.add(filePath);
    }

    /**
     * Handle file delete event.
     * Removes the file from the cache.
     *
     * @param uri - URI of the deleted file
     */
    private handleDelete(uri: vscode.Uri): void {
        const filePath = uri.fsPath;

        log(`FileWatcher: Deleted: ${filePath}`);

        // Remove from cache (no need to check include paths)
        this.cacheManager.remove(filePath);
    }

    /**
     * Rebuild the index for a file in the background.
     *
     * @param filePath - Absolute file path to rebuild
     */
    private async rebuildIndexInBackground(filePath: string): Promise<void> {
        try {
            const fileIndex = this.cacheManager.get(filePath);
            if (fileIndex) {
                const result = await this.threadPool.submitIndex({ type: 'index', filePath });
                if (result.lineStarts) {
                    fileIndex.setLineStarts(result.lineStarts);
                    log(`FileWatcher: Re-Indexed: ${filePath}`);
                } else if (result.error) {
                    warn(`FileWatcher: Failed to rebuild index for ${filePath}: ${result.error}`);
                }
            }
        } catch (error) {
            warn(`FileWatcher: Failed to rebuild index for ${filePath}: ${error}`);
        }
    }

    /**
     * Update configuration and recreate watchers.
     *
     * @param includePaths - New list of directory paths to include
     * @param fileExtensions - New list of file extensions to include
     */
    updateConfig(includePaths: string[], fileExtensions: string[]): void {
        this.includePaths = includePaths;
        this.fileExtensions = fileExtensions.map(ext => ext.toLowerCase());
        this.createWatchers();
    }

    /**
     * Get the current include paths configuration.
     */
    getIncludePaths(): string[] {
        return this.includePaths;
    }

    /**
     * Get the current file extensions configuration.
     */
    getFileExtensions(): string[] {
        return this.fileExtensions;
    }

    /**
     * Clean up all watchers and event subscriptions.
     */
    private cleanupWatchers(): void {
        for (const watcher of this.watchers) {
            watcher.dispose();
        }
        this.watchers = [];

        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
    }

    /**
     * Dispose of the file watcher and clean up resources.
     */
    dispose(): void {
        this.cleanupWatchers();
    }
}
