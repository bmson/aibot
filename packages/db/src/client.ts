import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>;

/** Pool shape, defaulted to match @assistant/config so a bare call still works. */
export interface DbPoolOptions {
  max?: number;
  idleTimeoutSeconds?: number;
  connectTimeoutSeconds?: number;
  statementTimeoutMs?: number;
}

/**
 * A pool with limits on every axis.
 *
 * `max` alone is not a bound on anything the database cares about: without an
 * idle timeout a container holds its whole pool open for its lifetime whether
 * or not it is doing anything, and without a statement timeout one query that
 * never finishes pins a connection with nothing left to release it. Both are
 * how a pool that looked fine in testing becomes a service that cannot open a
 * connection in production.
 *
 * The statement timeout is a server-side setting, so it applies to every query
 * on the connection regardless of which client issued it.
 */
export function createDb(url: string, options: DbPoolOptions = {}) {
  const statementTimeoutMs = options.statementTimeoutMs ?? 60_000;
  const client = postgres(url, {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeoutSeconds ?? 30,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    onnotice: () => {},
    ...(statementTimeoutMs > 0 ? { connection: { statement_timeout: statementTimeoutMs } } : {}),
  });
  return drizzle(client, { schema });
}
