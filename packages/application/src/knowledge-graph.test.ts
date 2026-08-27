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
  getKnowledgeGraphCalendar,
  getKnowledgeGraphNeighborhood,
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
// Above the application layer's 80-row relation cap on purpose: these tests
// exist to prove the reported counts are queried rather than taken from the
// page, and a fixture that fits inside the cap cannot show the difference.
const ENTITY_COUNT = 85;

let db: Db;
let dbUp = false;
let agentId: string;
let hubId: string;
let memoryId: string;

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
    memoryId = memory.id;

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
    // The list itself stays bounded — that it is strictly shorter than the
    // total is what proves the cap is in play and the count is not just the
    // array's length wearing a different name.
    expect(overview.relations.length).toBeLessThan(overview.selectedRelationTotal);
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

describe('knowledge graph kind filter (integration)', () => {
  it('narrows the true match count and every returned row to the kind', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const overview = await getKnowledgeGraphOverview(db, {
      query: MARKER,
      kind: 'organization',
      pageSize: 100,
    });
    expect(overview.matchingEntities).toBe(ENTITY_COUNT);
    expect(overview.entities).toHaveLength(ENTITY_COUNT);
    expect(overview.entities.every((entity) => entity.kind === 'organization')).toBe(true);

    const topics = await getKnowledgeGraphOverview(db, { query: MARKER, kind: 'topic' });
    expect(topics.matchingEntities).toBe(1);
    expect(topics.entities[0]?.id).toBe(hubId);

    // No place entities exist anywhere in the fixture, so this is zero no
    // matter which other suite has run.
    const none = await getKnowledgeGraphOverview(db, { query: MARKER, kind: 'place' });
    expect(none.matchingEntities).toBe(0);
    expect(none.entities).toHaveLength(0);
  });

  it('pages a filtered list without repeating an item', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const first = await getKnowledgeGraphOverview(db, {
      query: MARKER,
      kind: 'organization',
      pageSize: 20,
      page: 1,
    });
    const second = await getKnowledgeGraphOverview(db, {
      query: MARKER,
      kind: 'organization',
      pageSize: 20,
      page: 2,
    });
    const overlap = first.entities.filter((entity) =>
      second.entities.some((other) => other.id === entity.id),
    );
    expect(overlap).toEqual([]);
    expect(first.entityPages).toBe(Math.ceil(ENTITY_COUNT / 20));
  });

  it('treats an unknown kind as no filter rather than an empty graph', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // Compared against the unfiltered query rather than a hardcoded count:
    // other suites' fixtures legitimately shift the absolute number.
    const filtered = await getKnowledgeGraphOverview(db, { query: MARKER, kind: 'not-a-kind' });
    const unfiltered = await getKnowledgeGraphOverview(db, { query: MARKER });
    expect(filtered.matchingEntities).toBe(unfiltered.matchingEntities);
  });

  it('still selects a deep-linked entity whose kind is filtered out', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // ?kind=place&entity=<the topic hub> must open the hub, not nothing —
    // otherwise switching filters would silently lose a shared link's subject.
    const overview = await getKnowledgeGraphOverview(db, {
      query: MARKER,
      kind: 'place',
      entityId: hubId,
    });
    expect(overview.matchingEntities).toBe(0);
    expect(overview.selected?.id).toBe(hubId);
  });
});

describe('knowledge graph neighborhood (integration)', () => {
  beforeAll(async () => {
    if (!dbUp) return;
    // An earlier test flips one hub edge to rejected; the neighbourhood tests
    // assert exact active counts, so the fixture starts from a known state
    // rather than depending on file order.
    await db
      .update(knowledgeGraphRelations)
      .set({ reviewStatus: 'unreviewed' })
      .where(eq(knowledgeGraphRelations.subjectEntityId, hubId));
  });

  it('returns every active edge of a high-degree hub, past the old 80-row cap', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const neighborhood = await getKnowledgeGraphNeighborhood(db, { entityId: hubId });
    expect(neighborhood.entity?.id).toBe(hubId);
    expect(neighborhood.edges).toHaveLength(ENTITY_COUNT);
    expect(neighborhood.total).toBe(ENTITY_COUNT);
    expect(neighborhood.edges.every((edge) => edge.outbound)).toBe(true);
  });

  it('honours a limit while reporting the true degree', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const neighborhood = await getKnowledgeGraphNeighborhood(db, { entityId: hubId, limit: 10 });
    expect(neighborhood.edges).toHaveLength(10);
    expect(neighborhood.total).toBe(ENTITY_COUNT);
  });

  it('excludes stale edges from both the page and the count', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [stale] = await db
      .select({ id: knowledgeGraphRelations.id })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.subjectEntityId, hubId))
      .limit(1);
    if (!stale) throw new Error('no relation to mark stale');
    await db
      .update(knowledgeGraphRelations)
      .set({ reviewStatus: 'rejected' })
      .where(eq(knowledgeGraphRelations.id, stale.id));
    try {
      const neighborhood = await getKnowledgeGraphNeighborhood(db, { entityId: hubId });
      expect(neighborhood.total).toBe(ENTITY_COUNT - 1);
      expect(neighborhood.edges.map((edge) => edge.id)).not.toContain(stale.id);
    } finally {
      await db
        .update(knowledgeGraphRelations)
        .set({ reviewStatus: 'unreviewed' })
        .where(eq(knowledgeGraphRelations.id, stale.id));
    }
  });

  it('orders confirmed edges ahead of unreviewed ones', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const confirmed = await db
      .select({ id: knowledgeGraphRelations.id })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.subjectEntityId, hubId))
      .limit(2);
    for (const row of confirmed) {
      await db
        .update(knowledgeGraphRelations)
        .set({ reviewStatus: 'confirmed' })
        .where(eq(knowledgeGraphRelations.id, row.id));
    }
    try {
      const neighborhood = await getKnowledgeGraphNeighborhood(db, { entityId: hubId });
      const firstTwo = neighborhood.edges.slice(0, 2).map((edge) => edge.id);
      expect(new Set(firstTwo)).toEqual(new Set(confirmed.map((row) => row.id)));
      expect(neighborhood.edges[2]?.reviewStatus).toBe('unreviewed');
    } finally {
      for (const row of confirmed) {
        await db
          .update(knowledgeGraphRelations)
          .set({ reviewStatus: 'unreviewed' })
          .where(eq(knowledgeGraphRelations.id, row.id));
      }
    }
  });

  it('reads a spoke as a degree-1 node with the edge pointing at the hub', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [spoke] = await db
      .select({ id: knowledgeGraphEntities.id })
      .from(knowledgeGraphEntities)
      .where(like(knowledgeGraphEntities.canonicalKey, `organization:${MARKER} spoke 000`))
      .limit(1);
    if (!spoke) throw new Error('spoke fixture missing');
    const neighborhood = await getKnowledgeGraphNeighborhood(db, { entityId: spoke.id });
    expect(neighborhood.edges).toHaveLength(1);
    expect(neighborhood.edges[0]?.outbound).toBe(false);
    expect(neighborhood.edges[0]?.other.id).toBe(hubId);
  });

  it('answers empty for an entity id that is not in the graph', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const neighborhood = await getKnowledgeGraphNeighborhood(db, {
      entityId: '00000000-0000-4000-8000-000000000000',
    });
    expect(neighborhood.entity).toBeNull();
    expect(neighborhood.edges).toEqual([]);
    expect(neighborhood.total).toBe(0);
  });
});

describe('knowledge graph calendar (integration)', () => {
  const calendarEntityIds: string[] = [];

  beforeAll(async () => {
    if (!dbUp) return;
    // Date entities group by canonical key, so the marker cannot ride inside
    // the key; cleanup below is by tracked id. Labels deliberately avoid the
    // marker so the count-sensitive sidebar tests never see these rows.
    const fixtures: Array<{ canonicalKey: string; label: string; kind?: string }> = [
      { canonicalKey: 'date:2026-03-06', label: '6 March 2026' },
      { canonicalKey: 'date:2026-03-21', label: '21 March 2026' },
      { canonicalKey: 'date:--03-06', label: 'March 6' },
      { canonicalKey: 'date:2026-03', label: 'March 2026' },
      { canonicalKey: 'date:2026', label: '2026' },
      { canonicalKey: 'date:2026-04-02', label: '2 April 2026' },
      // The second-hop fixtures: an event on 6 March and the person on it.
      { canonicalKey: 'event:spring offsite', label: 'Spring offsite', kind: 'event' },
      { canonicalKey: 'person:brynja', label: 'Brynja', kind: 'person' },
    ];
    const inserted = await db
      .insert(knowledgeGraphEntities)
      .values(fixtures.map((fixture) => ({ agentId, kind: 'date', ...fixture })))
      .returning({
        id: knowledgeGraphEntities.id,
        canonicalKey: knowledgeGraphEntities.canonicalKey,
      });
    calendarEntityIds.push(...inserted.map((row) => row.id));

    const idFor = (key: string) => {
      const row = inserted.find((item) => item.canonicalKey === key);
      if (!row) throw new Error(`calendar fixture missing for ${key}`);
      return row.id;
    };
    // Every in-month date (and the recurring one) connects to the hub; the
    // year-only and next-month dates get edges too, so the test can assert
    // they are left out rather than merely absent.
    const keys = [
      'date:2026-03-06',
      'date:2026-03-21',
      'date:--03-06',
      'date:2026-03',
      'date:2026',
      'date:2026-04-02',
    ];
    await db.insert(knowledgeGraphRelations).values([
      ...keys.map((key, index) => ({
        agentId,
        subjectEntityId: hubId,
        predicate: 'mentions',
        objectEntityId: idFor(key),
        sourceMemoryId: memoryId,
        evidenceQuote: `${MARKER} calendar fixture`,
        sourceFingerprint: `${MARKER}-cal-${index}`,
        ordinal: 100 + index,
        confidence: '0.90',
        // The 21 March edge is stale: the calendar must not show it.
        reviewStatus: key === 'date:2026-03-21' ? ('rejected' as const) : ('confirmed' as const),
      })),
      // The event's own edges: one to the date (first hop from the calendar's
      // side), one to a person (the second hop the cell should surface).
      {
        agentId,
        subjectEntityId: idFor('event:spring offsite'),
        predicate: 'happens_on',
        objectEntityId: idFor('date:2026-03-06'),
        sourceMemoryId: memoryId,
        evidenceQuote: `${MARKER} calendar fixture`,
        sourceFingerprint: `${MARKER}-cal-event-on`,
        ordinal: 200,
        confidence: '0.90',
        reviewStatus: 'confirmed' as const,
      },
      {
        agentId,
        subjectEntityId: idFor('event:spring offsite'),
        predicate: 'attended_by',
        objectEntityId: idFor('person:brynja'),
        sourceMemoryId: memoryId,
        evidenceQuote: `${MARKER} calendar fixture`,
        sourceFingerprint: `${MARKER}-cal-event-attendee`,
        ordinal: 201,
        confidence: '0.90',
        reviewStatus: 'confirmed' as const,
      },
    ]);
  });

  afterAll(async () => {
    if (!dbUp) return;
    // Relations cascade from their endpoint entities.
    for (const id of calendarEntityIds) {
      await db.delete(knowledgeGraphEntities).where(eq(knowledgeGraphEntities.id, id));
    }
  });

  it('rejects a month that is not a real month', async (ctx) => {
    if (!dbUp) return ctx.skip();
    expect(await getKnowledgeGraphCalendar(db, { month: 'nonsense' })).toBeNull();
    expect(await getKnowledgeGraphCalendar(db, { month: '2026-13' })).toBeNull();
  });

  it('groups exact, recurring, and month-precision dates by canonical key', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const calendar = await getKnowledgeGraphCalendar(db, { month: '2026-03' });
    if (!calendar) throw new Error('calendar came back null');

    expect(calendar.days['06']).toHaveLength(2);
    const recurring = calendar.days['06']?.find((entry) => entry.recurring);
    const exact = calendar.days['06']?.find((entry) => !entry.recurring);
    expect(recurring?.entity.canonicalKey).toBe('date:--03-06');
    expect(exact?.entity.canonicalKey).toBe('date:2026-03-06');
    // Both carry their live hub connection.
    expect(exact?.connections.map((conn) => conn.other.id)).toContain(hubId);
    expect(recurring?.connections.map((conn) => conn.other.id)).toContain(hubId);

    expect(calendar.monthEntry?.entity.canonicalKey).toBe('date:2026-03');
    expect(calendar.monthEntry?.connections.map((conn) => conn.other.id)).toContain(hubId);
  });

  it('carries a second hop for events, and never for broad kinds', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const calendar = await getKnowledgeGraphCalendar(db, { month: '2026-03' });
    if (!calendar) throw new Error('calendar came back null');

    const exact = calendar.days['06']?.find((entry) => !entry.recurring);
    const eventConn = exact?.connections.find((conn) => conn.other.kind === 'event');
    // The person on the event surfaces; the event's edge back to the date
    // itself does not (that day has its own cell).
    expect(eventConn?.other.label).toBe('Spring offsite');
    expect(eventConn?.related.map((item) => item.label)).toEqual(['Brynja']);

    // A topic hub with 85 neighbours is never expanded into the cell.
    const hubConn = exact?.connections.find((conn) => conn.other.id === hubId);
    expect(hubConn?.related).toEqual([]);
  });

  it('leaves year-only and other-month dates out, and drops stale edges', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const calendar = await getKnowledgeGraphCalendar(db, { month: '2026-03' });
    if (!calendar) throw new Error('calendar came back null');

    const allEntities = Object.values(calendar.days)
      .flat()
      .map((entry) => entry.entity.canonicalKey);
    expect(allEntities).not.toContain('date:2026');
    expect(allEntities).not.toContain('date:2026-04-02');

    // The only edge touching 21 March is rejected: the entity appears (it is
    // a real node) but shows no connections, and the counts exclude the edge.
    // Year-only and other-month entities are not in the month's id set, so
    // their edges are not counted either — three hub edges plus the event's
    // happens_on remain.
    expect(calendar.days['21']).toHaveLength(1);
    expect(calendar.days['21']?.[0]?.connections).toHaveLength(0);
    expect(calendar.totalConnections).toBe(4);
    expect(calendar.shownConnections).toBe(4);
  });

  it('answers an empty month without inventing rows', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const calendar = await getKnowledgeGraphCalendar(db, { month: '2031-11' });
    expect(calendar).toMatchObject({
      month: '2031-11',
      days: {},
      monthEntry: null,
      totalConnections: 0,
      shownConnections: 0,
    });
  });
});
