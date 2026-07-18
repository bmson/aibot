import {
  agents,
  conversationSegments,
  conversations,
  createDb,
  type Db,
  messages,
} from '@assistant/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelRouter } from '../model-router/router.js';
import { segmentConversations } from './segmentation.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

function unit(i: number): number[] {
  const v = new Array(1536).fill(0);
  v[i] = 1;
  return v;
}

// Summaries embed to a fixed vector; every generate() returns a canned summary.
const fakeRouter = {
  async embed(texts: string[]) {
    return texts.map(() => new Array(1536).fill(0.02));
  },
  async generate() {
    return {
      ok: true as const,
      modelId: 'fake',
      degraded: false,
      text: 'Discussed the topic and agreed next steps.',
    };
  },
} as unknown as ModelRouter;

const BASE = new Date('2025-02-01T09:00:00.000Z');
const at = (minutesAfter: number) => new Date(BASE.getTime() + minutesAfter * 60_000);
const FUTURE = new Date(BASE.getTime() + 48 * 60 * 60_000); // well past the settle window

let db: Db;
let dbUp = false;
let agentId: string;
let conversationId: string;
const messageIds: string[] = [];

async function seedMessage(embedding: number[], text: string, createdAt: Date): Promise<void> {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId,
      role: 'user',
      origin: 'owner',
      parts: [],
      text,
      embedding,
      createdAt,
    })
    .returning();
  messageIds.push((row as NonNullable<typeof row>).id);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    // A dedicated agent isolates this run from every other conversation.
    const [agent] = await db
      .insert(agents)
      .values({
        name: 'Segment Test',
        email: `segment-test-${BASE.getTime()}@example.com`,
        workspacePrefix: 'segment-test',
      })
      .returning();
    agentId = (agent as NonNullable<typeof agent>).id;
    dbUp = true;
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'segment-test' })
      .returning();
    conversationId = (conversation as NonNullable<typeof conversation>).id;

    // Topic A (three turns), then a drift to topic B (three turns), one minute
    // apart so no time gap fires — the drift is the only boundary.
    await seedMessage(unit(0), 'A1 kubernetes rollout plan', at(0));
    await seedMessage(unit(0), 'A2 staging first then prod', at(1));
    await seedMessage(unit(0), 'A3 rollback if error rate spikes', at(2));
    await seedMessage(unit(1), 'B1 apartment lease terms', at(3));
    await seedMessage(unit(1), 'B2 twelve month term', at(4));
    await seedMessage(unit(1), 'B3 sign by friday', at(5));
  } catch {
    console.warn('segmentation.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    await db
      .delete(conversationSegments)
      .where(eq(conversationSegments.conversationId, conversationId));
    if (messageIds.length) await db.delete(messages).where(inArray(messages.id, messageIds));
    await db.delete(conversations).where(eq(conversations.id, conversationId));
    await db.delete(agents).where(eq(agents.id, agentId));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('segmentConversations (integration)', () => {
  it('splits a conversation into topic segments at the drift boundary', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await segmentConversations({ db, router: fakeRouter }, { agentId, now: FUTURE });
    expect(result.segmentsCreated).toBe(2);

    const segs = await db
      .select()
      .from(conversationSegments)
      .where(eq(conversationSegments.conversationId, conversationId))
      .orderBy(conversationSegments.startedAt);
    expect(segs).toHaveLength(2);
    expect(segs.map((s) => s.messageCount)).toEqual([3, 3]);
    expect(segs.every((s) => s.summary.length > 0)).toBe(true);
    expect(segs.every((s) => s.embedding !== null)).toBe(true);
    // First segment spans topic A, second spans topic B.
    expect(segs[0]?.startedAt.toISOString()).toBe(at(0).toISOString());
    expect(segs[0]?.endedAt.toISOString()).toBe(at(2).toISOString());
    expect(segs[1]?.startedAt.toISOString()).toBe(at(3).toISOString());
    expect(segs[1]?.endedAt.toISOString()).toBe(at(5).toISOString());
  });

  it('is idempotent — a second run adds nothing', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await segmentConversations({ db, router: fakeRouter }, { agentId, now: FUTURE });
    expect(result.segmentsCreated).toBe(0);
    const count = await db
      .select()
      .from(conversationSegments)
      .where(eq(conversationSegments.conversationId, conversationId));
    expect(count).toHaveLength(2);
  });

  it('holds back a still-active trailing group until it settles', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // "now" just after the last message: the trailing (only) group has not
    // settled, so nothing new is committed on a fresh conversation.
    const [freshConvo] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'segment-test-fresh' })
      .returning();
    const freshId = (freshConvo as NonNullable<typeof freshConvo>).id;
    const [m1] = await db
      .insert(messages)
      .values({
        conversationId: freshId,
        role: 'user',
        origin: 'owner',
        parts: [],
        text: 'C1 hi',
        embedding: unit(2),
        createdAt: at(10),
      })
      .returning();
    const [m2] = await db
      .insert(messages)
      .values({
        conversationId: freshId,
        role: 'user',
        origin: 'owner',
        parts: [],
        text: 'C2 there',
        embedding: unit(2),
        createdAt: at(11),
      })
      .returning();

    const result = await segmentConversations(
      { db, router: fakeRouter },
      { agentId, now: at(12) }, // one minute after the last message → not settled
    );
    const segs = await db
      .select()
      .from(conversationSegments)
      .where(eq(conversationSegments.conversationId, freshId));
    expect(segs).toHaveLength(0);
    expect(result.segmentsCreated).toBe(0);

    // cleanup
    await db
      .delete(messages)
      .where(
        inArray(messages.id, [
          (m1 as NonNullable<typeof m1>).id,
          (m2 as NonNullable<typeof m2>).id,
        ]),
      );
    await db.delete(conversations).where(eq(conversations.id, freshId));
  });
});
