/**
 * Pure module declarations and deployment planning.
 *
 * This entry point may be imported by offline tooling. It intentionally does
 * not export diagnostics or runtime config helpers, which load .env and are
 * reserved for application and setup runtime callers.
 */
export * from './contract.js';
export * from './plan.js';
export * from './registry.js';
export * from './ui.js';
