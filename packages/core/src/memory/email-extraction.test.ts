import { conversations, createDb, type Db, emailIngest, memories, messages } from '@assistant/db';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import type { ModelRouter } from '../model-router/router.js';
import { ingestFactQuarantined, runEmailIngestExtraction } from './email-extraction.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-email-extract-${Date.now()}`;

let db: Db;
let dbUp = false;
let agentId: string;
let conversationId: string;
const ingestIds: string[] = [];

/** Scripted router: one owner-logistics fact per email, constant embeddings. */
function scriptedRouter(fact: Record<string, unknown>): ModelRouter {
  return {
    async object() {
      return {
        ok: true,
        modelId: 'fake',
        degraded: false,
        object: { facts: [fact], occasions: [] },
      };
    },
    async embed(values: string[]) {
      return values.map(() => Array.from({ length: 1536 }, () => 0.01));
    },
  } as unknown as ModelRouter;
}

async function ingestRow(input: {
  category: string;
  importance: number;
  body: string;
  id: string;
}) {
  const channelMessageId = `gmail:${MARKER}-${input.id}`;
  await db.insert(messages).values({
    conversationId,
    role: 'user',
    origin: 'unknown',
    parts: [{ type: 'text', text: input.body }],
    text: input.body,
    channelMessageId,
  });
  const [row] = await db
    .insert(emailIngest)
    .values({
      agentId,
      conversationId,
      channelMessageId,
      fromEmail: 'bookings@airline.example',
      subject: `${MARKER} itinerary`,
      contentTrust: 'unknown',
      authenticated: true,
      category: input.category,
      importance: input.importance,
      actionable: true,
      reason: 'test',
    })
    .returning({ id: emailIngest.id });
  if (row) ingestIds.push(row.id);
  return row;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('email-extraction.test: database unreachable — skipping');
    return;
  }
  const [conv] = await db
    .insert(conversations)
    .values({ agentId, channel: 'email', trust: 'unknown', title: `${MARKER} thread` })
    .returning();
  conversationId = (conv as NonNullable<typeof conv>).id;
});

afterAll(async () => {
  if (dbUp) {
    await db.delete(memories).where(like(memories.content, `%${MARKER}%`));
    if (ingestIds.length) await db.delete(emailIngest).where(inArray(emailIngest.id, ingestIds));
    if (conversationId) {
      await db.delete(messages).where(eq(messages.conversationId, conversationId));
      await db.delete(conversations).where(eq(conversations.id, conversationId));
    }
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('ingestFactQuarantined', () => {
  // The split is about what a false entry costs. A wrong flight time is
  // self-correcting; a wrong claim about a person is unfalsifiable and lingers.
  it('lets owner logistics through', () => {
    for (const category of ['travel', 'appointment', 'financial', 'commitment', 'security']) {
      expect(ingestFactQuarantined({ category, subject: 'owner', kind: 'fact' })).toBe(false);
    }
  });

  it('holds anything about another person', () => {
    expect(ingestFactQuarantined({ category: 'travel', subject: 'Anna', kind: 'fact' })).toBe(true);
    expect(ingestFactQuarantined({ category: 'travel', subject: 'owner', kind: 'person' })).toBe(
      true,
    );
  });

  it('holds asserted preferences — a marketer would love to write those', () => {
    expect(
      ingestFactQuarantined({ category: 'travel', subject: 'owner', kind: 'preference' }),
    ).toBe(true);
  });

  it('holds non-logistics categories', () => {
    for (const category of ['personal', 'bulk', 'other']) {
      expect(ingestFactQuarantined({ category, subject: 'owner', kind: 'fact' })).toBe(true);
    }
  });
});

describe('runEmailIngestExtraction', () => {
  it('makes owner logistics recallable and stamps the row', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const content = `The owner flies to Oslo on 1 September 2026 at 08:00 (${MARKER})`;
    const row = await ingestRow({
      category: 'travel',
      importance: 4,
      body: 'You depart 1 September at 08:00 from gate B12.',
      id: 'flight',
    });

    const result = await runEmailIngestExtraction({
      db,
      router: scriptedRouter({
        content,
        kind: 'fact',
        category: 'knowledge',
        subject: 'owner',
        relationship: '',
        domain: 'other',
        importance: 4,
        confidence: 0.9,
        validFrom: '',
      }),
    });
    expect(result.usable).toBeGreaterThanOrEqual(1);

    const [saved] = await db.select().from(memories).where(eq(memories.content, content));
    expect(saved).toBeDefined();
    // The whole point: visible to memory.recall, which filters quarantined.
    expect(saved?.quarantined).toBe(false);
    expect(saved?.source).toBe('email-ingest');
    // Third-party mail is never a first-hand source, so confidence is capped.
    expect(Number(saved?.confidence)).toBeLessThanOrEqual(0.8);

    const [stamped] = await db
      .select()
      .from(emailIngest)
      .where(eq(emailIngest.id, row?.id ?? ''));
    expect(stamped?.extractedAt).not.toBeNull();
  });

  it('quarantines a claim about a third party from the same mailbox', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const content = `Anna Testsdottir is moving to Bergen in September (${MARKER})`;
    await ingestRow({
      category: 'personal',
      importance: 4,
      body: 'Just so you know, Anna is moving to Bergen in September.',
      id: 'gossip',
    });

    await runEmailIngestExtraction({
      db,
      router: scriptedRouter({
        content,
        kind: 'fact',
        category: 'knowledge',
        subject: 'Anna Testsdottir',
        relationship: 'friend',
        domain: 'relationships',
        importance: 3,
        confidence: 0.9,
        validFrom: '',
      }),
    });

    const [saved] = await db.select().from(memories).where(eq(memories.content, content));
    expect(saved?.quarantined).toBe(true);
  });

  it('spends no extraction call on routine mail but still drains the ledger', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const row = await ingestRow({
      category: 'bulk',
      importance: 1,
      body: 'Our summer sale is here, with lots of things in it for you to buy today.',
      id: 'newsletter',
    });
    let called = false;
    const router = {
      async object() {
        called = true;
        return { ok: true, modelId: 'fake', degraded: false, object: { facts: [], occasions: [] } };
      },
      async embed(values: string[]) {
        return values.map(() => Array.from({ length: 1536 }, () => 0.01));
      },
    } as unknown as ModelRouter;

    const result = await runEmailIngestExtraction({ db, router });
    expect(called).toBe(false);
    expect(result.skippedLowImportance).toBeGreaterThanOrEqual(1);
    // Stamped anyway, so the backlog drains instead of being re-read nightly.
    const [stamped] = await db
      .select()
      .from(emailIngest)
      .where(eq(emailIngest.id, row?.id ?? ''));
    expect(stamped?.extractedAt).not.toBeNull();
  });

  it('visits each message once', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // Everything from the earlier cases is stamped, so a second pass finds
    // nothing to do — the ledger is a cursor, not a rolling window.
    const result = await runEmailIngestExtraction({ db, router: scriptedRouter({}) });
    const mine = ingestIds.length;
    expect(mine).toBeGreaterThan(0);
    expect(result.extracted).toBe(0);
  });
});
