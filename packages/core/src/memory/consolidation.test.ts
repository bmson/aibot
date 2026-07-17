import { createHash } from 'node:crypto';
import { contacts, createDb, type Db, memories, ownerCard } from '@assistant/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import type { ModelRouter } from '../model-router/router.js';
import { compileOwnerCard, pickWinner, runMemoryConsolidation } from './consolidation.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

const MARKER = 'xtest-consolidation';

let db: Db;
let dbUp = false;
let agentId: string;
let ownerId: string;
const factIds: Record<string, string> = {};

async function insertFact(
  key: string,
  input: {
    content: string;
    confidence: string;
    createdAt?: Date;
    domain?: string;
    quarantined?: boolean;
    ownerConfirmed?: boolean;
    importance?: number;
    pinned?: boolean;
  },
) {
  const [row] = await db
    .insert(memories)
    .values({
      agentId,
      category: 'knowledge',
      kind: 'fact',
      content: input.content,
      contentHash: createHash('sha256').update(input.content).digest('hex'),
      confidence: input.confidence,
      importance: input.importance ?? 3,
      originTrust: 'owner',
      quarantined: input.quarantined ?? false,
      ownerConfirmed: input.ownerConfirmed ?? false,
      pinned: input.pinned ?? false,
      subjectContactId: ownerId,
      domain: input.domain,
      createdAt: input.createdAt,
    })
    .returning({ id: memories.id });
  factIds[key] = (row as NonNullable<typeof row>).id;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000);

/**
 * Detects one duplicate pair and one contradiction pair; fixes one domain;
 * proposes one merge whose group also (incorrectly) includes a confirmed fact.
 */
const fakeRouter = {
  async object() {
    return {
      ok: true,
      modelId: 'fake',
      degraded: false,
      object: {
        duplicateGroups: [[factIds.dupA, factIds.dupB]],
        contradictionGroups: [[factIds.oldJob, factIds.newJob]],
        mergeGroups: [
          {
            ids: [factIds.mergeA, factIds.mergeB, factIds.mergeConfirmed],
            unified: `${MARKER}: runs 5k on Tuesdays while training for a half marathon`,
          },
        ],
        domainFixes: [{ id: factIds.noDomain, domain: 'home' }],
        timeline: [{ id: factIds.newJob, validFrom: '2024-03-01', validUntil: '' }],
      },
    };
  },
  async embed(texts: string[]) {
    return texts.map(() => new Array(1536).fill(0.01));
  },
} as unknown as ModelRouter;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('consolidation.test: database unreachable — skipping');
    return;
  }
  const [owner] = await db.select().from(contacts).where(eq(contacts.trust, 'owner')).limit(1);
  ownerId = (owner as NonNullable<typeof owner>).id;

  await insertFact('dupA', {
    content: `${MARKER}: drinks his coffee black`,
    confidence: '0.60',
    createdAt: daysAgo(30),
    domain: 'preferences',
  });
  await insertFact('dupB', {
    content: `${MARKER}: takes coffee without milk or sugar`,
    confidence: '0.80',
    createdAt: daysAgo(2),
    domain: 'preferences',
  });
  // importance 5 keeps the survivor above the card's auto-include threshold
  // and inside the per-domain cap even when the database holds real work facts
  await insertFact('oldJob', {
    content: `${MARKER}: works at Oldcorp as an engineer`,
    confidence: '0.90',
    createdAt: daysAgo(300),
    domain: 'work',
    importance: 5,
  });
  await insertFact('newJob', {
    content: `${MARKER}: works at Newcorp since March 2024`,
    confidence: '0.80',
    createdAt: daysAgo(3),
    domain: 'work',
    importance: 5,
  });
  await insertFact('noDomain', {
    content: `${MARKER}: lives in a flat in the Mission district`,
    confidence: '0.70',
    createdAt: daysAgo(10),
  });
  await insertFact('quarantinedFact', {
    content: `${MARKER}: secretly dislikes his neighbor`,
    confidence: '0.50',
    quarantined: true,
  });
  await insertFact('mergeA', {
    content: `${MARKER}: runs 5k on Tuesday mornings`,
    confidence: '0.80',
    domain: 'health',
  });
  await insertFact('mergeB', {
    content: `${MARKER}: is training for a half marathon`,
    confidence: '0.60',
    domain: 'health',
  });
  await insertFact('mergeConfirmed', {
    content: `${MARKER}: does yoga every Sunday`,
    confidence: '1.00',
    domain: 'health',
    ownerConfirmed: true,
  });
});

afterAll(async () => {
  if (dbUp) {
    await db.delete(memories).where(sql`${memories.content} LIKE ${`${MARKER}%`}`);
    await compileOwnerCard(db); // leave the card clean of test facts
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('pickWinner', () => {
  const base = {
    agentId: 'agent',
    content: '',
    kind: 'fact',
    importance: 3,
    domain: null,
    pinned: false,
    validFrom: null,
    validUntil: null,
  };
  it('newer wins when confidence is close (confidence-weighted newer-wins)', () => {
    const older = {
      ...base,
      id: 'a',
      confidence: '0.85',
      ownerConfirmed: false,
      createdAt: daysAgo(300),
    };
    const newer = {
      ...base,
      id: 'b',
      confidence: '0.80',
      ownerConfirmed: false,
      createdAt: daysAgo(1),
    };
    expect(pickWinner([older, newer]).id).toBe('b');
  });
  it('clearly higher confidence beats recency', () => {
    const older = {
      ...base,
      id: 'a',
      confidence: '0.95',
      ownerConfirmed: false,
      createdAt: daysAgo(300),
    };
    const newer = {
      ...base,
      id: 'b',
      confidence: '0.40',
      ownerConfirmed: false,
      createdAt: daysAgo(1),
    };
    expect(pickWinner([older, newer]).id).toBe('a');
  });
  it('owner-confirmed always wins', () => {
    const confirmed = {
      ...base,
      id: 'a',
      confidence: '0.30',
      ownerConfirmed: true,
      createdAt: daysAgo(300),
    };
    const newer = {
      ...base,
      id: 'b',
      confidence: '0.99',
      ownerConfirmed: false,
      createdAt: daysAgo(1),
    };
    expect(pickWinner([confirmed, newer]).id).toBe('a');
  });
});

describe('memory consolidation (integration)', () => {
  it('expires duplicates and contradiction losers with supersededById, assigns domains, compiles card', async (ctx) => {
    if (!dbUp) return ctx.skip();

    const result = await runMemoryConsolidation({ db, router: fakeRouter });
    expect(result.entities).toBeGreaterThanOrEqual(1);
    expect(result.duplicatesExpired).toBeGreaterThanOrEqual(1);
    expect(result.contradictionsResolved).toBeGreaterThanOrEqual(1);
    expect(result.cardCompiled).toBe(true);

    // duplicate: higher-confidence newer dupB survives; dupA expired, superseded by dupB
    const [dupA] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, factIds.dupA as string));
    const [dupB] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, factIds.dupB as string));
    expect(dupA?.expiresAt).not.toBeNull();
    expect(dupA?.supersededById).toBe(factIds.dupB);
    expect(dupB?.expiresAt).toBeNull();

    // contradiction: newer job wins (confidence-weighted newer-wins), loser expired not deleted
    const [oldJob] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, factIds.oldJob as string));
    const [newJob] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, factIds.newJob as string));
    expect(oldJob?.expiresAt).not.toBeNull();
    expect(oldJob?.supersededById).toBe(factIds.newJob);
    expect(newJob?.expiresAt).toBeNull();
    expect(newJob?.validFrom?.toISOString().slice(0, 10)).toBe('2024-03-01');

    // domain assignment
    const [noDomain] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, factIds.noDomain as string));
    expect(noDomain?.domain).toBe('home');

    // merge: unified fact created, members expired with provenance,
    // owner-confirmed member left untouched
    expect(result.factsUnified).toBe(2);
    const [unified] = await db
      .select()
      .from(memories)
      .where(
        sql`${memories.content} = ${`${MARKER}: runs 5k on Tuesdays while training for a half marathon`}`,
      );
    expect(unified).toBeDefined();
    expect(unified?.originTrust).toBe('assistant');
    expect(unified?.domain).toBe('health');
    expect(unified?.confidence).toBe('0.60'); // min of members
    expect(unified?.embedding).not.toBeNull();
    expect(unified?.expiresAt).toBeNull();
    const [mergeA] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, factIds.mergeA as string));
    const [mergeB] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, factIds.mergeB as string));
    const [mergeConfirmed] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, factIds.mergeConfirmed as string));
    expect(mergeA?.expiresAt).not.toBeNull();
    expect(mergeA?.supersededById).toBe(unified?.id);
    expect(mergeB?.expiresAt).not.toBeNull();
    expect(mergeB?.supersededById).toBe(unified?.id);
    expect(mergeConfirmed?.expiresAt).toBeNull();
    expect(mergeConfirmed?.supersededById).toBeNull();

    // owner card: contains survivors, excludes expired losers and quarantined facts
    const [card] = await db.select().from(ownerCard).where(eq(ownerCard.id, 1));
    expect(card?.content).toContain('Newcorp');
    expect(card?.content).not.toContain('Oldcorp');
    expect(card?.content).not.toContain('neighbor');

    // rotation cursor: every reviewed fact is stamped so the next run's window
    // prefers facts that haven't been looked at yet (nulls first)
    expect(dupB?.lastConsolidatedAt).not.toBeNull();
    expect(mergeConfirmed?.lastConsolidatedAt).not.toBeNull();
    const [quarantinedFact] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, factIds.quarantinedFact as string));
    expect(quarantinedFact?.lastConsolidatedAt).toBeNull();
  });
});

describe('compileOwnerCard pinning (integration)', () => {
  it('pinned facts always make the card; unpinned facts beyond the per-domain cap do not', async (ctx) => {
    if (!dbUp) return ctx.skip();

    // Auto-inclusion needs importance >= 4 and caps at 2 per domain; pinned
    // facts make the card no matter how unimportant or shaky they look.
    const health = [
      ['cardHigh1', 5, '0.90'], // in: high importance, top ranked
      ['cardHigh2', 4, '0.85'], // in: high importance, second
      ['cardHigh3', 4, '0.80'], // out: third high-importance fact, over the cap
      ['cardMid', 3, '0.99'], // out: ordinary importance never auto-surfaces
    ] as const;
    for (const [key, importance, confidence] of health) {
      await insertFact(key, {
        content: `${MARKER}: ${key} sleeps with the window open`,
        confidence,
        domain: 'health',
        importance,
      });
    }
    await insertFact('healthPinned', {
      content: `${MARKER}: healthPinned is allergic to penicillin`,
      confidence: '0.10',
      domain: 'health',
      importance: 1,
      pinned: true,
    });

    const content = await compileOwnerCard(db);
    expect(content).toContain('healthPinned is allergic to penicillin');
    expect(content).toContain('cardHigh1 sleeps with the window open');
    expect(content).toContain('cardHigh2 sleeps with the window open');
    expect(content).not.toContain('cardHigh3 sleeps with the window open');
    expect(content).not.toContain('cardMid sleeps with the window open');
    // overflow is surfaced to the model so it knows recall has more
    expect(content).toContain('memory.recall');
  });
});
