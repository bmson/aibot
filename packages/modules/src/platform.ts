import type { Config } from '@assistant/config';
import type { ModelRouter } from '@assistant/core';
import type { Db } from '@assistant/db';
import type { ToolRegistry } from '@assistant/tools/registry';
import type { WorkspaceStore } from '@assistant/tools/workspace';
import type { ModuleMeta } from './contract.js';

/**
 * The runtime half of the module contract. Unlike `contract.ts`, this reaches
 * into core, db, and tools, so only the agent composition root imports it —
 * never the web app or the deployment scripts.
 */

/**
 * Infrastructure every module receives. It stays deliberately small: modules
 * consume the platform through this context and *produce* their own provider
 * clients as exports, rather than the platform growing a field per provider.
 */
export interface ModulePlatformContext {
  config: Config;
  db: Db;
  registry: ToolRegistry;
  router: ModelRouter;
  workspace: WorkspaceStore;
  workspacePrefix: string;
  workspaceRoot: string;
  repoRoot: string;
}

/**
 * What installing a module produced. Tools are registered as a side effect on
 * `context.registry` — the only path into the risk-gated dispatcher — so they
 * do not appear here.
 */
export interface ModuleRuntime<Exports = void> {
  exports?: Exports;
}

export interface ModuleDefinition<Exports = void> {
  meta: ModuleMeta;
  /** Called only when the module is installed. */
  create: (context: ModulePlatformContext) => ModuleRuntime<Exports>;
  /**
   * What this module's exports look like when it is *not* installed.
   *
   * Providers that callers query unconditionally — `deps.googleClient`,
   * `deps.twilio` — declare a null object here whose `configured()` reports
   * false. `requireExports` then always has a value to return, so the
   * composition root holds a plain field rather than an optional one.
   */
  absent?: () => Exports;
}

/** Identity helper that infers a module's export type from its factory. */
export function defineModule<Exports = void>(
  definition: ModuleDefinition<Exports>,
): ModuleDefinition<Exports> {
  return definition;
}
