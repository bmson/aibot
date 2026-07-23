// Server-only singletons. Cached on globalThis so Next dev hot-reload doesn't
// leak postgres connection pools on every recompile.
import path from 'node:path';
import { getAgent, loadConfig, ModelRouter, repoRoot } from '@assistant/core';
import { contacts, createDb, type Db } from '@assistant/db';
import { GcsWorkspaceStore, LocalWorkspaceStore, type WorkspaceStore } from '@assistant/tools';
import { eq } from 'drizzle-orm';
import { cache } from 'react';

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

/**
 * The owner's timezone (from the agent row), for rendering local timestamps.
 * cache() dedupes it to one query per request across all server components.
 * Falls back to UTC if the agent can't be read.
 */
export const getAgentTimezone = cache(async (): Promise<string> => {
  try {
    return (await getAgent(getDb())).timezone || 'UTC';
  } catch {
    return 'UTC';
  }
});

/**
 * The assistant's display identity (agent row). The name is seed-owned — it
 * matches the bot's Google-account profile so email From headers agree — and
 * the dashboard displays it wherever the assistant "speaks".
 */
export const getAgentIdentity = cache(
  async (): Promise<{ name: string; avatarUrl: string | null }> => {
    try {
      const agent = await getAgent(getDb());
      return { name: agent.name || 'Assistant', avatarUrl: agent.avatarUrl ?? null };
    } catch {
      return { name: 'Assistant', avatarUrl: null };
    }
  },
);

/**
 * The owner's first name for greetings, from the owner-trust contact row.
 * Null (never a placeholder) when unset so callers can fall back gracefully.
 */
export const getOwnerFirstName = cache(async (): Promise<string | null> => {
  try {
    const [owner] = await getDb()
      .select({ name: contacts.name })
      .from(contacts)
      .where(eq(contacts.trust, 'owner'))
      .limit(1);
    return owner?.name.trim().split(/\s+/)[0] || null;
  } catch {
    return null;
  }
});

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
