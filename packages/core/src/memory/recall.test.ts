import { conversations, createDb, type Db, messages } from '@assistant/db';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import { recallRelevantContext, recentWindowStart } from './recall.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

/** Unit basis vector at index `i` — cosine 1 against itself, 0 against a different index. */
function unit(i: number): number[] {
  const v = new Array(1536).fill(0);
  v[i] = 1;
  return v;
}
const RELEVANT = unit(0); // matches the query embedding below
const OFF_TOPIC = unit(1); // orthogonal → similarity 0

/** The query always embeds to RELEVANT, so RELEVANT messages clear the threshold. */
const queryEmbed = async () => [RELEVANT];

const BASE = new Date('2025-03-01T12:00:00.000Z');
const at = (minutesBefore: number) => new Date(BASE.getTime() - minutesBefore * 60_000);
const SINCE = at(5); // live-window boundary: anything at/after this is "in context"

let db: Db;
let dbUp = false;
let agentId: string;
const conversationIds: string[] = [];
const messageIds: string[] = [];

async function seedConversation(trust: string, channel = 'chat'): Promise<string> {
  const [row] = await db
    .insert(conversations)
    .values({ agentId, channel, trust, title: 'recall-test' })
    .returning();
  const id = (row as NonNullable<typeof row>).id;
  conversationIds.push(id);
  return id;
}

async function seedMessage(input: {
  conversationId: string;
  role: 'user' | 'assistant';
  origin: 'owner' | 'assistant' | 'unknown';
  text: string;
  embedding: number[];
  createdAt: Date;
}): Promise<void> {
  const [row] = await db
    .insert(messages)
    .values({ ...input, parts: [] })
    .returning();
  messageIds.push((row as NonNullable<typeof row>).id);
}

let currentConversationId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('recall.test: database unreachable — skipping');
    return;
  }

  currentConversationId = await seedConversation('owner');
  const otherOwner = await seedConversation('owner');
  const untrusted = await seedConversation('unknown', 'email');
  const isolatedOwner = await seedConversation('owner');

  // Current conversation: one relevant message inside the live window (must be
  // excluded) and one older relevant message outside it (must be recalled).
  await seedMessage({
    conversationId: currentConversationId,
    role: 'user',
    origin: 'owner',
    text: 'RECENT_MARKER the kubernetes rollout is happening now',
    embedding: RELEVANT,
    createdAt: BASE,
  });
  await seedMessage({
    conversationId: currentConversationId,
    role: 'user',
    origin: 'owner',
    text: 'OLD_MARKER we planned the kubernetes rollout in three stages',
    embedding: RELEVANT,
    createdAt: at(20),
  });

  // A different owner thread: a relevant anchor plus an off-topic neighbor that
  // should ride along via neighborhood expansion (it is meaningless alone).
  await seedMessage({
    conversationId: otherOwner,
    role: 'user',
    origin: 'owner',
    text: 'OTHER_MARKER the apartment lease terms were 12 months',
    embedding: RELEVANT,
    createdAt: at(60),
  });
  await seedMessage({
    conversationId: otherOwner,
    role: 'assistant',
    origin: 'assistant',
    text: 'NEIGHBOR_MARKER got it, sign by friday',
    embedding: OFF_TOPIC,
    createdAt: new Date(at(60).getTime() + 30_000),
  });

  // Untrusted (stranger email) thread: relevant but must never surface.
  await seedMessage({
    conversationId: untrusted,
    role: 'user',
    origin: 'unknown',
    text: 'UNTRUSTED_MARKER kubernetes rollout from a stranger',
    embedding: RELEVANT,
    createdAt: at(90),
  });

  // Isolated off-topic owner message: below threshold and next to no relevant
  // anchor, so it is neither recalled nor pulled in as a neighbor.
  await seedMessage({
    conversationId: isolatedOwner,
    role: 'user',
    origin: 'owner',
    text: 'IRRELEVANT_MARKER what is the weather tomorrow',
    embedding: OFF_TOPIC,
    createdAt: at(40),
  });
});

afterAll(async () => {
  if (dbUp) {
    if (messageIds.length) await db.delete(messages).where(inArray(messages.id, messageIds));
    if (conversationIds.length) {
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    }
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('recallRelevantContext (integration)', () => {
  it('recalls relevant earlier owner discussion outside the live window', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await recallRelevantContext(db, {
      agentId,
      queryText: 'how did we plan the kubernetes rollout',
      embed: queryEmbed,
      exclude: { conversationId: currentConversationId, sinceCreatedAt: SINCE },
    });

    // Recalled: older relevant turn in this thread, and a relevant turn from
    // another owner thread.
    expect(result.block).toContain('OLD_MARKER');
    expect(result.block).toContain('OTHER_MARKER');
    // Neighborhood expansion carries the adjacent off-topic reply for context.
    expect(result.block).toContain('NEIGHBOR_MARKER');
    expect(result.used).toBeGreaterThanOrEqual(2);
    expect(result.candidates).toBeGreaterThanOrEqual(2);
  });

  it('excludes the live window, untrusted threads, and below-threshold matches', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await recallRelevantContext(db, {
      agentId,
      queryText: 'how did we plan the kubernetes rollout',
      embed: queryEmbed,
      exclude: { conversationId: currentConversationId, sinceCreatedAt: SINCE },
    });

    expect(result.block).not.toContain('RECENT_MARKER'); // already in the live window
    expect(result.block).not.toContain('UNTRUSTED_MARKER'); // stranger-trust thread
    expect(result.block).not.toContain('IRRELEVANT_MARKER'); // below similarity threshold
  });

  it('does not inject a neighborhood twice (dedup)', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await recallRelevantContext(db, {
      agentId,
      queryText: 'how did we plan the kubernetes rollout',
      embed: queryEmbed,
      exclude: { conversationId: currentConversationId, sinceCreatedAt: SINCE },
    });
    for (const marker of ['OLD_MARKER', 'OTHER_MARKER', 'NEIGHBOR_MARKER']) {
      expect((result.block.match(new RegExp(marker, 'g')) ?? []).length).toBe(1);
    }
  });

  it('injects nothing when no earlier discussion clears the threshold', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // An off-topic query embeds to OFF_TOPIC; the only OFF_TOPIC messages are
    // the isolated one and the neighbor, and neither is a relevant anchor.
    const result = await recallRelevantContext(db, {
      agentId,
      queryText: 'unrelated question',
      embed: async () => [unit(9)], // orthogonal to every seeded message
      exclude: { conversationId: currentConversationId, sinceCreatedAt: SINCE },
    });
    expect(result.block).toBe('');
    expect(result.used).toBe(0);
  });

  it('ignores a too-short query without embedding', async (ctx) => {
    if (!dbUp) return ctx.skip();
    let embedCalls = 0;
    const result = await recallRelevantContext(db, {
      agentId,
      queryText: 'hi',
      embed: async () => {
        embedCalls += 1;
        return [RELEVANT];
      },
      exclude: { conversationId: currentConversationId, sinceCreatedAt: SINCE },
    });
    expect(result.block).toBe('');
    expect(embedCalls).toBe(0);
  });

  it('recentWindowStart returns the oldest of the last N owner/assistant turns', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const start = await recentWindowStart(db, currentConversationId, 20);
    expect(start?.toISOString()).toBe(at(20).toISOString());
  });
});
