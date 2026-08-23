import { agents, createDb, type Db } from '@assistant/db';
import { DrizzleError } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from './chat.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    await db.select().from(agents).limit(1);
    dbUp = true;
  } catch {
    console.warn('get-agent.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('getAgent (integration)', () => {
  it('resolves the oldest agent even when heap order disagrees', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // Everything runs in a rolled-back transaction: the extra agent rows are
    // never committed, so concurrently running integration tests never see
    // them. getAgent is a global first-row lookup — a committed older row
    // would hijack every other test's agent resolution for its duration.
    try {
      await db.transaction(async (tx) => {
        const asDb = tx as unknown as Db;
        const stamp = `${Date.now()}-${Math.round(performance.now())}`;
        // Insert the newer row first so insertion order and created_at
        // disagree: an unordered limit(1) would return this newer row.
        await tx.insert(agents).values({
          name: 'Newer Agent',
          email: `newer-${stamp}@example.com`,
          workspacePrefix: `workspace/newer-${stamp}`,
          createdAt: new Date('2026-01-02T00:00:00Z'),
        });
        const [older] = await tx
          .insert(agents)
          .values({
            name: 'Older Agent',
            email: `older-${stamp}@example.com`,
            workspacePrefix: `workspace/older-${stamp}`,
            createdAt: new Date('2026-01-01T00:00:00Z'),
          })
          .returning();
        const olderId = (older as NonNullable<typeof older>).id;

        expect((await getAgent(asDb)).id).toBe(olderId);

        // And stays resolved to it after row updates, which is what moved heap
        // rows around and flipped the unordered pick between launches.
        await tx.update(agents).set({ updatedAt: new Date() });
        expect((await getAgent(asDb)).id).toBe(olderId);

        tx.rollback();
      });
    } catch (error) {
      // rollback() unwinds by throwing; anything else is a real failure.
      if (!(error instanceof DrizzleError && error.message === 'Rollback')) throw error;
    }
  });
});
