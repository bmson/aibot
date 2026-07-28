import path from 'node:path';
import { type Config, isModuleEnabled, loadConfig, repoRoot } from '@assistant/config';
import { type DocumentProcessorConfig, ModelRouter } from '@assistant/core';
import { createDb, type Db } from '@assistant/db';
import {
  assistantModules,
  browserModule,
  documentsModule,
  googleModule,
  type InstalledModuleSet,
  installModules,
  smsModule,
  unconfiguredGoogleClient,
  unconfiguredTwilioClient,
} from '@assistant/modules';
import type { BrowserJobLauncher } from '@assistant/tools/browser';
import { registerBuiltinTools } from '@assistant/tools/builtin';
import { ToolDispatcher } from '@assistant/tools/dispatcher';
import type { GoogleClient } from '@assistant/tools/modules/google';
import type { TwilioClient } from '@assistant/tools/modules/sms';
import { ToolRegistry } from '@assistant/tools/registry';
import {
  GcsWorkspaceStore,
  LocalWorkspaceStore,
  type WorkspaceStore,
} from '@assistant/tools/workspace';

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
  googleClient: GoogleClient;
  twilio: TwilioClient;
  browserLauncher?: BrowserJobLauncher;
  documentProcessor?: DocumentProcessorConfig;
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
  // workspace tools. Optional provider/worker modules are installed below.
  const registry = registerBuiltinTools(new ToolRegistry(), {
    embed: (texts) => router.embed(texts),
    workspace,
    documentsEnabled: isModuleEnabled(config, 'documents'),
  });
  const modules = installModules(assistantModules, {
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
    // Callers query these unconditionally, so an uninstalled provider becomes a
    // client that reports itself unconfigured rather than an absent field.
    googleClient: modules.exportsOf(googleModule) ?? unconfiguredGoogleClient(),
    twilio: modules.exportsOf(smsModule) ?? unconfiguredTwilioClient(),
    ...(browserLauncher ? { browserLauncher } : {}),
    ...(documentProcessor ? { documentProcessor } : {}),
  };
  return cached;
}
