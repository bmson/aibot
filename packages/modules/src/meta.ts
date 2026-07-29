/**
 * The plain-data entry point, published as `@assistant/modules/meta`.
 *
 * Nothing reachable from here imports provider code, so the web app, the
 * deployment scripts, and the setup wizard can read module metadata without
 * pulling tools, core, or the database into their bundles.
 * `scripts/check-boundaries.ts` holds the web app to this subpath.
 */
export * from './contract.js';
export * from './diagnostics.js';
export { gmailSyncEnabled } from './google/meta.js';
export * from './plan.js';
export * from './registry.js';
export * from './ui.js';
