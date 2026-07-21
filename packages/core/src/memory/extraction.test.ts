import { createHash } from 'node:crypto';
import {
  addTombstone,
  contacts,
  conversations,
  createDb,
  type Db,
  memories,
  memoryTombstones,
  messages,
  occasions,
} from '@assistant/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import type { ModelRouter } from '../model-router/router.js';
import { runMemoryExtraction } from './extraction.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

const MARKER = 'xtest-extraction';
const FACT_OWNER = `Baldvin (${MARKER}) plays padel every Tuesday evening`;
const FACT_PERSON = `Solveig Extractsdottir (${MARKER}) is moving to Bergen in September`;
const FACT_FORGOTTEN = `Baldvin (${MARKER}) once lived in a lighthouse`;

let db: Db;
let dbUp = false;
let agentId: string;
const conversationIds: string[] = [];

/**
 * Scripted router: object() returns fixed facts ONLY for the test conversation
 * (a dev DB can hold other recent conversations — extraction scans them all);
 * embed() returns constant vectors.
 */
const fakeRouter = {
  async object(_role: string, opts: { prompt?: string }) {
    if (!opts.prompt?.includes('Solveig')) {
      return { ok: true, modelId: 'fake', degraded: false, object: { facts: [] } };
    }
    return {
      ok: true,
      modelId: 'fake',
      degraded: false,
      object: {
        facts: [
          {
            content: FACT_OWNER,
            kind: 'preference',
            category: 'knowledge',
            subject: 'owner',
            relationship: '',
            domain: 'preferences',
            importance: 3,
            confidence: 0.8,
            validFrom: '',
          },
          {
            content: FACT_PERSON,
            kind: 'person',
            category: 'knowledge',
            subject: 'Solveig Extractsdottir',
            relationship: 'friend',
            domain: 'relationships',
            importance: 3,
            confidence: 0.7,
            validFrom: '',
          },
          {
            content: FACT_FORGOTTEN,
            kind: 'fact',
            category: 'knowledge',
            subject: 'owner',
            relationship: '',
            domain: 'identity',
            importance: 2,
            confidence: 0.6,
            validFrom: '',
          },
        ],
        occasions: [
          {
            subject: 'Solveig Extractsdottir',
            kind: 'birthday',
            label: '',
            month: 9,
            day: 12,
            year: null,
            notes: '',
          },
        ],
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
    console.warn('extraction.test: database unreachable — skipping');
    return;
  }
  const [conversation] = await db
    .insert(conversations)
    .values({ agentId, channel: 'chat', trust: 'owner', title: MARKER })
    .returning();
  const convId = (conversation as NonNullable<typeof conversation>).id;
  conversationIds.push(convId);
  // embeddings pre-set so the concurrently-running maintenance backfill test
  // (shared DB) doesn't pick these up as work
  const preEmbedded = new Array(1536).fill(0.01);
  await db.insert(messages).values([
    {
      conversationId: convId,
      role: 'user',
      origin: 'owner',
      parts: [],
      text: 'I play padel every Tuesday, and my friend Solveig is moving to Bergen in September.',
      embedding: preEmbedded,
    },
    {
      conversationId: convId,
      role: 'assistant',
      origin: 'assistant',
      parts: [],
      text: 'Noted — padel Tuesdays, and Solveig off to Bergen.',
      embedding: preEmbedded,
    },
  ]);
  // pre-tombstone one fact: it must never be saved
  await addTombstone(db, createHash('sha256').update(FACT_FORGOTTEN).digest('hex'), 'test');
});

afterAll(async () => {
  if (dbUp) {
    await db.delete(memories).where(sql`${memories.content} LIKE ${`%${MARKER}%`}`);
    await db
      .delete(memoryTombstones)
      .where(
        eq(memoryTombstones.contentHash, createHash('sha256').update(FACT_FORGOTTEN).digest('hex')),
      );
    if (conversationIds.length) {
      await db.delete(messages).where(inArray(messages.conversationId, conversationIds));
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    }
    // Occasions FK the contact, so clear them before deleting Solveig.
    const [solveig] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.name, 'Solveig Extractsdottir'));
    if (solveig) await db.delete(occasions).where(eq(occasions.contactId, solveig.id));
    await db.delete(contacts).where(eq(contacts.name, 'Solveig Extractsdottir'));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('memory extraction (integration)', () => {
  it('attributes facts to entities, auto-creates unknown contacts, respects tombstones, dedupes', async (ctx) => {
    if (!dbUp) return ctx.skip();

    const first = await runMemoryExtraction({ db, router: fakeRouter });
    expect(first.saved).toBeGreaterThanOrEqual(2);
    expect(first.tombstoned).toBeGreaterThanOrEqual(1);

    // owner fact linked to the owner contact
    const [ownerContact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.trust, 'owner'))
      .limit(1);
    const [ownerFact] = await db.select().from(memories).where(eq(memories.content, FACT_OWNER));
    expect(ownerFact?.subjectContactId).toBe(ownerContact?.id);
    expect(ownerFact?.domain).toBe('preferences');
    expect(ownerFact?.quarantined).toBe(false);

    // person fact auto-created a trust:'unknown' contact with the relationship
    const [personContact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.name, 'Solveig Extractsdottir'));
    expect(personContact?.trust).toBe('unknown');
    expect(personContact?.relationship).toBe('friend');
    const [personFact] = await db.select().from(memories).where(eq(memories.content, FACT_PERSON));
    expect(personFact?.subjectContactId).toBe(personContact?.id);

    // Phase 17: the birthday mentioned in the conversation became an occasion
    // linked to Solveig, non-quarantined (owner-trust conversation).
    expect(first.occasionsSaved).toBeGreaterThanOrEqual(1);
    const [birthday] = await db
      .select()
      .from(occasions)
      .where(eq(occasions.contactId, personContact?.id ?? ''));
    expect(birthday?.kind).toBe('birthday');
    expect(birthday?.month).toBe(9);
    expect(birthday?.day).toBe(12);
    expect(birthday?.quarantined).toBe(false);

    // the tombstoned fact must not exist
    const forgotten = await db.select().from(memories).where(eq(memories.content, FACT_FORGOTTEN));
    expect(forgotten).toHaveLength(0);

    // second run: everything already stored → duplicates, nothing new (the
    // occasion dedupes on its unique date, so nothing new there either).
    const second = await runMemoryExtraction({ db, router: fakeRouter });
    expect(second.saved).toBe(0);
    expect(second.duplicates).toBeGreaterThanOrEqual(2);
    expect(second.occasionsSaved).toBe(0);
  });

  it('quarantines facts extracted from untrusted conversations', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // wipe the facts saved by the previous test so the scripted router re-saves them
    await db.delete(memories).where(sql`${memories.content} LIKE ${`%${MARKER}%`}`);
    await db
      .update(conversations)
      .set({ trust: 'unknown' })
      .where(inArray(conversations.id, conversationIds));

    const result = await runMemoryExtraction({ db, router: fakeRouter });
    expect(result.saved).toBeGreaterThanOrEqual(2);
    expect(result.quarantined).toBe(result.saved);

    const [fact] = await db.select().from(memories).where(eq(memories.content, FACT_OWNER));
    expect(fact?.quarantined).toBe(true);
    expect(fact?.originTrust).toBe('unknown');
  });
});
