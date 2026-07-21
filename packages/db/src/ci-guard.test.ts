import { describe, expect, it } from 'vitest';
import { createDb } from './index.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

/**
 * The many `if (!dbUp) return ctx.skip()` integration suites pass silently when
 * the database is unreachable — fine locally (Docker may be off), but in CI that
 * would let a broken database service turn the whole integration layer green
 * while running nothing. This guard makes that failure loud: when CI is set, the
 * database MUST be reachable, or the run fails here instead of skipping quietly.
 */
describe('CI database guard', () => {
  it('the shared database is reachable in CI', async () => {
    if (!process.env.CI) {
      // Local: a down database is expected; the skip-based suites handle it.
      return;
    }
    const db = createDb(DATABASE_URL);
    try {
      await db.execute('select 1');
    } finally {
      await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
    }
    expect(true).toBe(true);
  });
});
