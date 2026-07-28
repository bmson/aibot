import type { Config } from '@assistant/config';
import type { ModelRouter } from '@assistant/core';
import type { Db } from '@assistant/db';
import type { ToolRegistry } from '@assistant/tools/registry';
import type { WorkspaceStore } from '@assistant/tools/workspace';
import type { ModuleMeta } from './kit.js';

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
  /** Called only when the module is enabled. */
  create: (context: ModulePlatformContext) => ModuleRuntime<Exports>;
}

/** Identity helper that infers a module's export type from its factory. */
export function defineModule<Exports = void>(
  definition: ModuleDefinition<Exports>,
): ModuleDefinition<Exports> {
  return definition;
}
