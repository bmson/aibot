import { getAgent } from '@assistant/core/chat';
import {
  agents,
  createDb,
  type Db,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  memories,
} from '@assistant/db';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findDuplicateKnowledgeGraphEntities,
  getKnowledgeGraphOverview,
  searchKnowledgeGraphEntities,
} from './knowledge-graph.js';

/**
 * The review page used to report the graph as smaller than it is: a 60-row cap
 * with no total, a degree that was really a page size, and a merge list that
 * simply stopped at 200 entities. These assert the counts are the true ones.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-kgview-${Date.now()}`;
const ENTITY_COUNT = 75;

let db: Db;
let dbUp = false;
let agentId: string;
let hubId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    // getKnowledgeGraphOverview is deliberately the single owner's view and
    // resolves the agent itself, so the fixture has to hang off that same
    // agent rather than a private one. Seed it only if the database has none.
    let agentId_: string;
    try {
      agentId_ = (await getAgent(db)).id;
    } catch {
      const [created] = await db
        .insert(agents)
        .values({
          name: 'Knowledge Graph View Test',
          email: `${MARKER}@example.com`,
          workspacePrefix: MARKER,
        })
        .returning({ id: agents.id });
      if (!created) throw new Error('test agent was not created');
      agentId_ = created.id;
    }
    agentId = agentId_;

    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} hub relates to everything.`,
        contentHash: `${MARKER}-source`,
        confidence: '0.90',
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('test memory was not created');

    const [hub] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: `topic:${MARKER} hub`,
        label: `${MARKER} hub`,
        kind: 'topic',
      })
      .returning({ id: knowledgeGraphEntities.id });
    if (!hub) throw new Error('test hub entity was not created');
    hubId = hub.id;

    // Padded so lexical order matches numeric order, and every spoke is joined
    // to the hub so the hub's degree exceeds the 80-row relation cap.
    const spokes = await db
      .insert(knowledgeGraphEntities)
      .values(
        Array.from({ length: ENTITY_COUNT }, (_, index) => ({
          agentId,
          canonicalKey: `organization:${MARKER} spoke ${String(index).padStart(3, '0')}`,
          label: `${MARKER} spoke ${String(index).padStart(3, '0')}`,
          kind: 'organization',
        })),
      )
      .returning({ id: knowledgeGraphEntities.id });

    await db.insert(knowledgeGraphRelations).values(
      spokes.map((spoke, index) => ({
        agentId,
        subjectEntityId: hubId,
        predicate: 'relates_to',
        objectEntityId: spoke.id,
        sourceMemoryId: memory.id,
        evidenceQuote: `${MARKER} hub relates to everything`,
        sourceFingerprint: `${MARKER}-fp-${index}`,
        ordinal: index + 1,
        confidence: '0.90',
      })),
    );
    dbUp = true;
  } catch {
    console.warn('knowledge-graph.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    // The agent is shared, so only the marked fixtures come out. Relations
    // cascade from their source memory; entities are keyed by marker.
    await db.delete(memories).where(like(memories.content, `${MARKER}%`));
    await db
      .delete(knowledgeGraphEntities)
      .where(like(knowledgeGraphEntities.canonicalKey, `%${MARKER}%`));
    await db.delete(agents).where(eq(agents.email, `${MARKER}@example.com`));
  }
  await (db as unknown as { $client?: { end: () => Promise<void> } }).$client?.end?.();
});

describe('knowledge graph overview (integration)', () => {
  it('reports the true match count, not the size of the page it returned', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const overview = await getKnowledgeGraphOverview(db, { query: MARKER, pageSize: 20 });
    expect(overview.entities).toHaveLength(20);
    expect(overview.matchingEntities).toBe(ENTITY_COUNT + 1);
    expect(overview.entityPages).toBe(Math.ceil((ENTITY_COUNT + 1) / 20));
    expect(overview.entityPage).toBe(1);
  });

  it('pages through the matches without repeating one', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const first = await getKnowledgeGraphOverview(db, { query: MARKER, pageSize: 20, page: 1 });
    const second = await getKnowledgeGraphOverview(db, { query: MARKER, pageSize: 20, page: 2 });
    const overlap = first.entities.filter((entity) =>
      second.entities.some((other) => other.id === entity.id),
    );
    expect(overlap).toEqual([]);
  });

  it('clamps a page past the end instead of returning nothing', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const overview = await getKnowledgeGraphOverview(db, { query: MARKER, pageSize: 20, page: 99 });
    expect(overview.entityPage).toBe(overview.entityPages);
    expect(overview.entities.length).toBeGreaterThan(0);
  });

  it('reports the full degree even when the relation list is capped', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const overview = await getKnowledgeGraphOverview(db, { query: MARKER, entityId: hubId });
    expect(overview.selected?.id).toBe(hubId);
    expect(overview.selectedRelationTotal).toBe(ENTITY_COUNT);
    // The list itself stays bounded; the count above is what tells the truth.
    expect(overview.relations.length).toBeLessThanOrEqual(ENTITY_COUNT);
  });

  // The local map draws from the same capped page, so its own length would
  // report the cap as the degree — the exact failure this change exists to fix.
  it('counts active edges from a query, not from the page the map draws', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const before = await getKnowledgeGraphOverview(db, { query: MARKER, entityId: hubId });
    expect(before.selectedActiveRelationTotal).toBe(ENTITY_COUNT);
    expect(before.selectedActiveRelationTotal).toBeGreaterThan(before.relations.length);

    // Marking one stale must drop it from the active count but not the total.
    const [edge] = await db
      .select({ id: knowledgeGraphRelations.id })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.subjectEntityId, hubId))
      .limit(1);
    if (!edge) throw new Error('no relation to reject');
    await db
      .update(knowledgeGraphRelations)
      .set({ reviewStatus: 'rejected' })
      .where(eq(knowledgeGraphRelations.id, edge.id));

    const after = await getKnowledgeGraphOverview(db, { query: MARKER, entityId: hubId });
    expect(after.selectedActiveRelationTotal).toBe(ENTITY_COUNT - 1);
    expect(after.selectedRelationTotal).toBe(ENTITY_COUNT);
  });
});

describe('knowledge graph entity search (integration)', () => {
  it('reaches an entity far past where the old fixed list stopped', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const target = `${MARKER} spoke ${String(ENTITY_COUNT - 1).padStart(3, '0')}`;
    const rows = await searchKnowledgeGraphEntities(db, { query: target });
    expect(rows.map((row) => row.label)).toContain(target);
  });

  it('excludes the entity being merged and honours the kind filter', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const rows = await searchKnowledgeGraphEntities(db, {
      query: MARKER,
      excludeId: hubId,
      kind: 'organization',
    });
    expect(rows.map((row) => row.id)).not.toContain(hubId);
    expect(rows.every((row) => row.kind === 'organization')).toBe(true);
  });

  it('offers a shorter name as a duplicate of the longer one it prefixes', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [short] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: `person:${MARKER} anna`,
        label: `${MARKER} anna`,
        kind: 'person',
      })
      .returning({ id: knowledgeGraphEntities.id });
    const [long] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: `person:${MARKER} anna jonsdottir`,
        label: `${MARKER} anna jonsdottir`,
        kind: 'person',
      })
      .returning({ id: knowledgeGraphEntities.id });
    if (!short || !long) throw new Error('duplicate fixtures were not created');

    const duplicates = await findDuplicateKnowledgeGraphEntities(db, {
      id: short.id,
      label: `${MARKER} anna`,
      kind: 'person',
      canonicalKey: `person:${MARKER} anna`,
    });
    expect(duplicates.map((row) => row.targetId)).toContain(long.id);

    // A different kind is never a merge candidate, however the names look.
    const crossKind = await findDuplicateKnowledgeGraphEntities(db, {
      id: hubId,
      label: `${MARKER} anna`,
      kind: 'topic',
      canonicalKey: `topic:${MARKER} hub`,
    });
    expect(crossKind.map((row) => row.targetId)).not.toContain(long.id);
  });
});
