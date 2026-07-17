// Server-only singletons. Cached on globalThis so Next dev hot-reload doesn't
// leak postgres connection pools on every recompile.
import path from 'node:path';
import { loadConfig, ModelRouter, repoRoot } from '@assistant/core';
import { createDb, type Db } from '@assistant/db';
import { GcsWorkspaceStore, LocalWorkspaceStore, type WorkspaceStore } from '@assistant/tools';

const globalCache = globalThis as unknown as {
  __assistantDb?: Db;
  __assistantRouter?: ModelRouter;
  __assistantWorkspace?: WorkspaceStore;
};

export function getDb(): Db {
  globalCache.__assistantDb ??= createDb(loadConfig().DATABASE_URL);
  return globalCache.__assistantDb;
}

export function getRouter(): ModelRouter {
  globalCache.__assistantRouter ??= new ModelRouter(getDb(), loadConfig().OPENROUTER_API_KEY);
  return globalCache.__assistantRouter;
}

/** Same workspace the agent uses (prefix must match apps/agent/src/deps.ts). */
export function getWorkspace(): WorkspaceStore {
  if (!globalCache.__assistantWorkspace) {
    const config = loadConfig();
    globalCache.__assistantWorkspace =
      config.FILES_DRIVER === 'gcs'
        ? new GcsWorkspaceStore(config.WORKSPACE_BUCKET, 'workspace/b-bot')
        : new LocalWorkspaceStore(path.join(repoRoot, '.workspace'));
  }
  return globalCache.__assistantWorkspace;
}
