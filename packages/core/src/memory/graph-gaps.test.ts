import {
  contacts,
  createDb,
  type Db,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  memories,
  suggestions,
} from '@assistant/db';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import { findGraphGaps, markGapAsked, nextUnaskedGap } from './graph-gaps.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://assistant@localhost:5432/assistant';
const MARKER = `xtest-gaps-${Date.now()}`;

let db: Db;
let dbUp = false;
let agentId: string;
let memoryId: string;
const entityIds: string[] = [];

/** An entity plus `count` outgoing relations, so it clears the "cared about" bar. */
async function addEntity(
  label: string,
  kind: string,
  predicates: string[],
  opts: { contactId?: string; confidence?: string; reviewStatus?: string } = {},
) {
  const [entity] = await db
    .insert(knowledgeGraphEntities)
    .values({
      agentId,
      canonicalKey: `${kind}:${MARKER}-${label}`,
      label: `${MARKER} ${label}`,
      kind,
      ...(opts.contactId ? { contactId: opts.contactId } : {}),
    })
    .returning({ id: knowledgeGraphEntities.id });
  const id = (entity as NonNullable<typeof entity>).id;
  entityIds.push(id);

  // Objects for the edges to point at; their own degree stays 0 so they never
  // become candidates themselves.
  for (const [index, predicate] of predicates.entries()) {
    const [object] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: `topic:${MARKER}-${label}-${index}`,
        label: `${MARKER} object ${label} ${index}`,
        kind: 'topic',
      })
      .returning({ id: knowledgeGraphEntities.id });
    const objectId = (object as NonNullable<typeof object>).id;
    entityIds.push(objectId);
    await db.insert(knowledgeGraphRelations).values({
      agentId,
      subjectEntityId: id,
      predicate,
      objectEntityId: objectId,
      sourceMemoryId: memoryId,
      sourceFingerprint: `${MARKER}-${label}-${predicate}-${index}`,
      ordinal: index,
      confidence: opts.confidence ?? '0.9',
      reviewStatus: opts.reviewStatus ?? 'unreviewed',
    });
  }
  return id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('graph-gaps.test: database unreachable — skipping');
    return;
  }
  const [memory] = await db
    .insert(memories)
    .values({
      agentId,
      category: 'knowledge',
      kind: 'fact',
      content: `${MARKER} source`,
      contentHash: MARKER,
    })
    .returning({ id: memories.id });
  memoryId = (memory as NonNullable<typeof memory>).id;
});

afterAll(async () => {
  if (!dbUp || !memoryId) return;
  await db.delete(suggestions).where(like(suggestions.sourceRef, 'gap:%'));
  if (entityIds.length) {
    await db
      .delete(knowledgeGraphRelations)
      .where(inArray(knowledgeGraphRelations.subjectEntityId, entityIds));
    await db.delete(knowledgeGraphEntities).where(inArray(knowledgeGraphEntities.id, entityIds));
  }
  await db.delete(memories).where(eq(memories.id, memoryId));
  await db.delete(contacts).where(like(contacts.name, `${MARKER}%`));
});

describe('findGraphGaps', () => {
  it('ignores an entity the graph barely mentions', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // One relation only: below the "cared about" bar, so no question about it.
    const id = await addEntity('Peripheral', 'person', ['met']);
    const gaps = await findGraphGaps(db, agentId);
    expect(gaps.some((gap) => gap.key.includes(id))).toBe(false);
  });

  it('asks where a well-connected person lives and works', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const id = await addEntity('Anna', 'person', ['sibling_of', 'met', 'likes']);
    const gaps = await findGraphGaps(db, agentId);
    const mine = gaps.filter((gap) => gap.key.includes(id));
    expect(mine.map((gap) => gap.kind)).toContain('missing-predicate');
    const questions = mine.map((gap) => gap.question).join(' ');
    expect(questions).toContain('where');
    expect(questions).toContain(`${MARKER} Anna`);
  });

  it('does not ask about something an equivalent predicate already covers', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // `born_in` answers "where do they live" well enough not to interrogate.
    const id = await addEntity('Bjorn', 'person', ['born_in', 'works_at', 'met']);
    const gaps = await findGraphGaps(db, agentId);
    const asked = gaps.filter((gap) => gap.key.includes(id) && gap.kind === 'missing-predicate');
    expect(asked).toHaveLength(0);
  });

  it('offers to keep contact details for a person it only has notes about', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const id = await addEntity('Unlinked', 'person', ['met', 'likes', 'sibling_of']);
    const gaps = await findGraphGaps(db, agentId);
    expect(gaps.some((gap) => gap.kind === 'unlinked-person' && gap.key.includes(id))).toBe(true);
  });

  it('offers to confirm a relation extraction hedged on', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await addEntity('Unsure', 'person', ['works_at', 'lives_in', 'met'], {
      confidence: '0.3',
      reviewStatus: 'unreviewed',
    });
    const gaps = await findGraphGaps(db, agentId);
    expect(gaps.some((gap) => gap.kind === 'unreviewed-relation')).toBe(true);
  });

  it('ranks the best-connected gaps first', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const gaps = await findGraphGaps(db, agentId);
    const priorities = gaps.map((gap) => gap.priority);
    expect([...priorities].sort((a, b) => b - a)).toEqual(priorities);
  });
});

describe('nextUnaskedGap', () => {
  it('never asks the same question twice, however long it goes unanswered', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const gaps = await findGraphGaps(db, agentId);
    const first = await nextUnaskedGap(db, agentId, gaps);
    expect(first).not.toBeNull();

    expect(await markGapAsked(db, agentId, first as NonNullable<typeof first>)).toBe(true);
    // A second instance racing for the same gap loses the unique index.
    expect(await markGapAsked(db, agentId, first as NonNullable<typeof first>)).toBe(false);

    const second = await nextUnaskedGap(db, agentId, gaps);
    expect(second?.key).not.toBe(first?.key);
  });

  it('returns nothing when there is nothing to ask', async (ctx) => {
    if (!dbUp) return ctx.skip();
    expect(await nextUnaskedGap(db, agentId, [])).toBeNull();
  });
});
