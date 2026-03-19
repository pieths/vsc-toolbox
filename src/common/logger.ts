// Copyright (c) 2026 Piet Hein Schouten
// SPDX-License-Identifier: MIT

/**
 * Shared logger for the VSC Toolbox extension.
 *
 * The exported functions (`debug`, `log`, `warn`, `error`) are mutable
 * and start as no-ops. Call {@link configureLogger} once at startup to
 * wire them to the appropriate output.
 *
 * Every file in the extension — including content index internals —
 * imports from this single module.
 */

/** Log a debug-level message. No-op until configured. */
export let debug: (message: string) => void = () => { };

/** Log an info-level message. No-op until configured. */
export let log: (message: string) => void = () => { };

/** Log a warning-level message. No-op until configured. */
export let warn: (message: string) => void = () => { };

/** Log an error-level message. No-op until configured. */
export let error: (message: string) => void = () => { };

/**
 * Configure all logging functions at once.
 * Call this once at startup to wire the logger to the appropriate
 * output (vscode OutputChannel, IPC messages, console, etc.).
 */
export function configureLogger(impl: {
    debug: (message: string) => void;
    log: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
}): void {
    debug = impl.debug;
    log = impl.log;
    warn = impl.warn;
    error = impl.error;
}
