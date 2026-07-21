import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { budgets, createDb, type Db, modelRoles } from './index.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    await db.select().from(budgets).limit(1);
    dbUp = true;
  } catch {
    console.warn('runtime-defaults.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('runtime defaults (migrate + seed applied)', () => {
  it('raises the spend ceilings for reason-model routing', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const rows = await db
      .select()
      .from(budgets)
      .where(inArray(budgets.scope, ['task_default', 'daily', 'monthly']));
    const by = Object.fromEntries(rows.map((r) => [r.scope, r.limitUsd]));
    // Owner may raise these further; they must never sit below the Phase 3 floor.
    expect(Number(by.task_default)).toBeGreaterThanOrEqual(0.5);
    expect(Number(by.daily)).toBeGreaterThanOrEqual(4);
    expect(Number(by.monthly)).toBeGreaterThanOrEqual(50);
  });

  it('runs structured-output roles at temperature 0', async (ctx) => {
    if (!dbUp) return ctx.skip();
    for (const role of ['plan', 'classify', 'extract']) {
      const [row] = await db
        .select()
        .from(modelRoles)
        .where(and(eq(modelRoles.role, role)));
      const params = (row?.params ?? {}) as { temperature?: number };
      expect(params.temperature).toBe(0);
    }
  });
});
