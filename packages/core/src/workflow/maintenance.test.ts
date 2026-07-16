import { conversations, createDb, type Db, memories, messages, toolCache } from '@assistant/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import type { ModelRouter } from '../model-router/router.js';
import { backfillMessageEmbeddings, purgeExpired } from './maintenance.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;
let conversationId: string;
const messageIds: string[] = [];

const fakeRouter = {
  async embed(texts: string[]) {
    return texts.map(() => new Array(1536).fill(0.01));
  },
} as unknown as ModelRouter;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'maintenance-test' })
      .returning();
    conversationId = (conversation as NonNullable<typeof conversation>).id;
  } catch {
    console.warn('maintenance.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    if (messageIds.length) await db.delete(messages).where(inArray(messages.id, messageIds));
    await db.delete(conversations).where(eq(conversations.id, conversationId));
    await db.delete(toolCache).where(eq(toolCache.toolName, 'maint.test'));
    await db.delete(memories).where(eq(memories.contentHash, 'maint-test-hash'));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('maintenance (integration)', () => {
  it('backfills embeddings for substantial messages only, and only once', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [long] = await db
      .insert(messages)
      .values({
        conversationId,
        role: 'user',
        origin: 'owner',
        parts: [],
        text: 'This is a sufficiently long message about kubernetes clusters and deployments.',
      })
      .returning();
    const [short] = await db
      .insert(messages)
      .values({ conversationId, role: 'user', origin: 'owner', parts: [], text: 'ok' })
      .returning();
    messageIds.push((long as NonNullable<typeof long>).id, (short as NonNullable<typeof short>).id);

    const first = await backfillMessageEmbeddings(db, fakeRouter, 50);
    expect(first).toBeGreaterThanOrEqual(1);

    const [longAfter] = await db
      .select({ has: sql<boolean>`${messages.embedding} IS NOT NULL` })
      .from(messages)
      .where(eq(messages.id, (long as NonNullable<typeof long>).id));
    const [shortAfter] = await db
      .select({ has: sql<boolean>`${messages.embedding} IS NOT NULL` })
      .from(messages)
      .where(eq(messages.id, (short as NonNullable<typeof short>).id));
    expect(longAfter?.has).toBe(true);
    expect(shortAfter?.has).toBe(false); // too short to bother

    const second = await backfillMessageEmbeddings(db, fakeRouter, 50);
    expect(second).toBe(0); // nothing left to embed
  });

  it('purges expired cache rows and memories, keeps live ones', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await db.insert(toolCache).values([
      {
        cacheKey: 'maint-expired',
        toolName: 'maint.test',
        result: {},
        expiresAt: new Date(Date.now() - 1000),
      },
      {
        cacheKey: 'maint-live',
        toolName: 'maint.test',
        result: {},
        expiresAt: new Date(Date.now() + 3600e3),
      },
    ]);
    await db.insert(memories).values({
      agentId,
      category: 'experience',
      kind: 'episode',
      content: 'expired test memory',
      contentHash: 'maint-test-hash',
      expiresAt: new Date(Date.now() - 1000),
    });

    const purged = await purgeExpired(db);
    expect(purged.cache).toBeGreaterThanOrEqual(1);
    expect(purged.memories).toBeGreaterThanOrEqual(1);

    const remaining = await db.select().from(toolCache).where(eq(toolCache.toolName, 'maint.test'));
    expect(remaining.map((r) => r.cacheKey)).toEqual(['maint-live']);
  });
});
