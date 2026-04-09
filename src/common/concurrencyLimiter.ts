// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * A bounded concurrency queue that limits how many async operations
 * can be in flight at once, with an optional delay between dispatches.
 *
 * Usage:
 * ```typescript
 * const limiter = new ConcurrencyLimiter(3, 200);
 * const result = await limiter.run(() => someAsyncOperation());
 * ```
 */
export class ConcurrencyLimiter {
    private active = 0;
    private queue: (() => void)[] = [];
    private nextDispatchTime = 0;

    /**
     * @param maxConcurrency - Maximum number of concurrent operations
     * @param delayMs - Minimum gap in milliseconds between dispatches (default: 0)
     */
    constructor(
        private readonly maxConcurrency: number,
        private readonly delayMs: number = 0,
    ) {}

    /**
     * Run an async operation, waiting for a slot if necessary.
     * The slot is held until the operation's promise settles.
     * Dispatches are staggered by at least delayMs apart.
     */
    async run<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            // Reserve the next dispatch slot (synchronous — no interleaving)
            const now = Date.now();
            this.nextDispatchTime = Math.max(now, this.nextDispatchTime + this.delayMs);
            const waitMs = this.nextDispatchTime - now;
            if (waitMs > 0) {
                await new Promise(resolve => setTimeout(resolve, waitMs));
            }
            return await fn();
        } finally {
            this.release();
        }
    }

    private acquire(): Promise<void> {
        if (this.active < this.maxConcurrency) {
            this.active++;
            return Promise.resolve();
        }
        return new Promise(resolve => this.queue.push(resolve));
    }

    private release(): void {
        const next = this.queue.shift();
        if (next) {
            next(); // transfer slot directly to next waiter
        } else {
            this.active--;
        }
    }
}
