// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import watcher from '@parcel/watcher';
import { CacheManager } from './cacheManager';
import { PathFilter } from './pathFilter';
import { log, warn } from '../logger';

/**
 * FileWatcher monitors file system changes and updates the cache accordingly.
 * Uses @parcel/watcher to watch each include path recursively.
 * All file filtering is handled by PathFilter — @parcel/watcher watches
 * everything and events are filtered in the callback.
 */
export class FileWatcher {
    private cacheManager: CacheManager;
    private pathFilter: PathFilter;
    private subscriptions: watcher.AsyncSubscription[] = [];

    /**
     * Create a new file watcher.
     * Call {@link initialize} to start watching.
     *
     * @param cacheManager - Cache manager to update on file changes
     * @param pathFilter - PathFilter instance for include/exclude logic
     */
    constructor(
        cacheManager: CacheManager,
        pathFilter: PathFilter) {

        this.cacheManager = cacheManager;
        this.pathFilter = pathFilter;
    }

    /**
     * Subscribe to file system events for all include paths.
     * Must be awaited before the watcher is active.
     */
    async initialize(): Promise<void> {
        // Dispose existing subscriptions
        await this.cleanupWatchers();

        for (const includePath of this.pathFilter.getIncludePaths()) {
            try {
                const subscription = await watcher.subscribe(
                    includePath,
                    (err, events) => {
                        if (err) {
                            warn(`FileWatcher: Error from @parcel/watcher for ${includePath}: ${err.message}`);
                            return;
                        }
                        this.handleEvents(events);
                    },
                );
                this.subscriptions.push(subscription);
                log(`FileWatcher: Watching: ${includePath}`);
            } catch (err) {
                warn(`FileWatcher: Failed to watch ${includePath}: ${err}`);
            }
        }
    }

    /**
     * Handle a batch of file system events from @parcel/watcher.
     * Filters each event through PathFilter before forwarding to CacheManager.
     */
    private handleEvents(events: watcher.Event[]): void {
        for (const event of events) {
            if (!this.pathFilter.shouldIncludeFile(event.path)) {
                continue;
            }

            switch (event.type) {
                case 'create':
                    log(`FileWatcher: Created: ${event.path}`);
                    this.cacheManager.add(event.path);
                    break;
                case 'update':
                    this.cacheManager.markDirty(event.path);
                    break;
                case 'delete':
                    log(`FileWatcher: Deleted: ${event.path}`);
                    this.cacheManager.markDeleted(event.path);
                    break;
            }
        }
    }

    /**
     * Unsubscribe from all active watchers.
     */
    private async cleanupWatchers(): Promise<void> {
        for (const subscription of this.subscriptions) {
            try {
                await subscription.unsubscribe();
            } catch {
                /* ignore — subscription may already be dead */
            }
        }
        this.subscriptions = [];
    }

    /**
     * Dispose of the file watcher and clean up resources.
     */
    async dispose(): Promise<void> {
        await this.cleanupWatchers();
    }
}
