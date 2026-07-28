import path from 'node:path';
import { type Config, loadConfig, repoRoot } from '@assistant/config';
import { type DocumentProcessorConfig, ModelRouter } from '@assistant/core';
import { createDb, type Db } from '@assistant/db';
import {
  browserModule,
  composedModuleMetas as collectModuleMetas,
  documentsModule,
  type InstalledModuleSet,
  installModules,
  type ModuleMeta,
  type ModuleServices,
  type SmsChannelDeps,
  smsModule,
} from '@assistant/modules';
import type { BrowserJobLauncher } from '@assistant/tools/browser';
import { registerBuiltinTools } from '@assistant/tools/builtin';
import { ToolDispatcher } from '@assistant/tools/dispatcher';
import { ToolRegistry } from '@assistant/tools/registry';
import {
  GcsWorkspaceStore,
  LocalWorkspaceStore,
  type WorkspaceStore,
} from '@assistant/tools/workspace';
// The installation's composition file, at the repository root. Importing it
// here is what bakes the chosen modules into the built image.
import composition from '../../../assistant.config.js';

/**
 * Process-level dependency graph. Apps compose concrete adapters here while
 * business code consumes only the narrower ports exposed by core and tools.
 */
export interface AgentDeps {
  config: Config;
  db: Db;
  router: ModelRouter;
  registry: ToolRegistry;
  dispatcher: ToolDispatcher;
  workspace: WorkspaceStore;
  /** Installed capabilities, for code that asks a module what it produced. */
  modules: InstalledModuleSet;
  browserLauncher?: BrowserJobLauncher;
  documentProcessor?: DocumentProcessorConfig;
}

/**
 * The composed modules' plain metadata. Route mounters read this at import
 * time — before any deps exist — because Hono routes register statically while
 * enabled-guards evaluate per request.
 */
export const composedModuleMetas: readonly ModuleMeta[] = collectModuleMetas(composition);

/**
 * The sms channel's narrow deps, from the agent graph. Canaries — the one
 * consumer left in the agent — reach the channel through this; everything
 * else consumes the owner-notifier port.
 */
export function smsDeps(deps: AgentDeps): SmsChannelDeps {
  return {
    config: deps.config,
    db: deps.db,
    registry: deps.registry,
    twilio: deps.modules.requireExports(smsModule),
  };
}

/** The invocation-time services module hooks receive. */
export function agentServices(deps: AgentDeps): ModuleServices {
  return {
    config: deps.config,
    db: deps.db,
    router: deps.router,
    registry: deps.registry,
    dispatcher: deps.dispatcher,
    workspace: deps.workspace,
    ownerNotifier: deps.modules.ownerNotifier,
    emailObservers: deps.modules.emailObservers,
  };
}

let cached: AgentDeps | undefined;

export function buildDeps(): AgentDeps {
  if (cached) return cached;

  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);
  const router = new ModelRouter(db, config.OPENROUTER_API_KEY);
  const workspacePrefix = `workspace/${config.ASSISTANT_WORKSPACE_ID}`;
  const workspaceRoot = path.join(repoRoot, '.workspace');
  const workspace: WorkspaceStore =
    config.FILES_DRIVER === 'gcs'
      ? new GcsWorkspaceStore(config.WORKSPACE_BUCKET, workspacePrefix)
      : new LocalWorkspaceStore(workspaceRoot);

  // Built-ins are the base platform: memory, goals, approvals, missions, and
  // workspace tools. Optional provider/worker modules are installed below, and
  // each registers its own tools — the composition root names none of them.
  const registry = registerBuiltinTools(new ToolRegistry(), {
    embed: (texts) => router.embed(texts),
    workspace,
  });
  const modules = installModules(composition.modules, {
    config,
    db,
    registry,
    repoRoot,
    router,
    workspace,
    workspacePrefix,
    workspaceRoot,
  });

  const browserLauncher = modules.exportsOf(browserModule);
  const documentProcessor = modules.exportsOf(documentsModule);
  cached = {
    config,
    db,
    router,
    registry,
    dispatcher: new ToolDispatcher(db, registry),
    workspace,
    modules,
    ...(browserLauncher ? { browserLauncher } : {}),
    ...(documentProcessor ? { documentProcessor } : {}),
  };
  return cached;
}
