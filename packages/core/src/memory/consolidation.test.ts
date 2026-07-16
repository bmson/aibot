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
      importance: 3,
      originTrust: 'owner',
      quarantined: input.quarantined ?? false,
      ownerConfirmed: input.ownerConfirmed ?? false,
      subjectContactId: ownerId,
      domain: input.domain,
      createdAt: input.createdAt,
    })
    .returning({ id: memories.id });
  factIds[key] = (row as NonNullable<typeof row>).id;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000);

/** Detects one duplicate pair and one contradiction pair; fixes one domain. */
const fakeRouter = {
  async object() {
    return {
      ok: true,
      modelId: 'fake',
      degraded: false,
      object: {
        duplicateGroups: [[factIds.dupA, factIds.dupB]],
        contradictionGroups: [[factIds.oldJob, factIds.newJob]],
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
  await insertFact('oldJob', {
    content: `${MARKER}: works at Oldcorp as an engineer`,
    confidence: '0.90',
    createdAt: daysAgo(300),
    domain: 'work',
  });
  await insertFact('newJob', {
    content: `${MARKER}: works at Newcorp since March 2024`,
    confidence: '0.80',
    createdAt: daysAgo(3),
    domain: 'work',
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
    content: '',
    importance: 3,
    domain: null,
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

    // owner card: contains survivors, excludes expired losers and quarantined facts
    const [card] = await db.select().from(ownerCard).where(eq(ownerCard.id, 1));
    expect(card?.content).toContain('Newcorp');
    expect(card?.content).not.toContain('Oldcorp');
    expect(card?.content).not.toContain('neighbor');
  });
});
