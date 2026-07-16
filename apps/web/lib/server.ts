// Server-only singletons. Cached on globalThis so Next dev hot-reload doesn't
// leak postgres connection pools on every recompile.
import { loadConfig, ModelRouter } from '@assistant/core';
import { createDb, type Db } from '@assistant/db';

const globalCache = globalThis as unknown as {
  __assistantDb?: Db;
  __assistantRouter?: ModelRouter;
};

export function getDb(): Db {
  globalCache.__assistantDb ??= createDb(loadConfig().DATABASE_URL);
  return globalCache.__assistantDb;
}

export function getRouter(): ModelRouter {
  globalCache.__assistantRouter ??= new ModelRouter(getDb(), loadConfig().OPENROUTER_API_KEY);
  return globalCache.__assistantRouter;
}
