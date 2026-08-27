import {
  agents,
  createDb,
  type Db,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
} from '@assistant/db';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelRouter } from '../model-router/router.js';
import { recallKnowledgeGraph } from './graph-recall.js';
import {
  backfillKnowledgeGraphDates,
  countRelativeDateSources,
  createOwnerKnowledgeGraphFact,
  GRAPH_EXTRACTION_VERSION,
  graphRelationshipIsGrounded,
  retryQuarantinedKnowledgeGraphSources,
  syncKnowledgeGraph,
} from './knowledge-graph.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-graph-${Date.now()}`;

/** Mirrors the core normalizer closely enough for fixture key construction. */
function normalizedKey(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function unit(index: number): number[] {
  const vector = new Array(1536).fill(0);
  vector[index] = 1;
  return vector;
}

let db: Db;
let dbUp = false;
let agentId: string;

const router = {
  async object(_: string, input: { prompt?: string }) {
    if (input.prompt?.includes('worked at')) {
      return {
        ok: true,
        object: {
          relationships: [
            {
              subject: { label: `${MARKER} Owner`, kind: 'person' },
              predicate: 'worked_at',
              object: { label: `${MARKER} Acme`, kind: 'organization' },
              evidenceQuote: `${MARKER} Owner worked at ${MARKER} Acme from 2019 to March 2023.`,
              confidence: 0.9,
              validFrom: '2019',
              validUntil: 'March 2023',
            },
            {
              subject: { label: `${MARKER} Owner`, kind: 'person' },
              predicate: 'visited',
              object: { label: `${MARKER} Acme`, kind: 'organization' },
              evidenceQuote: `${MARKER} Owner visited ${MARKER} Acme often.`,
              confidence: 0.9,
              // '1492' is unquoted; 'often' is quoted but names no date.
              // Both must be dropped without taking the edge down.
              validFrom: '1492',
              validUntil: 'often',
            },
          ],
        },
      };
    }
    if (input.prompt?.includes('operates')) {
      return {
        ok: true,
        object: {
          relationships: [
            {
              subject: { label: `${MARKER} Acme`, kind: 'organization' },
              predicate: 'operates',
              object: { label: `${MARKER} Project Fox`, kind: 'project' },
              evidenceQuote: `${MARKER} Acme operates ${MARKER} Project Fox.`,
              confidence: 0.9,
            },
          ],
        },
      };
    }
    const employer = input.prompt?.includes('Replacement')
      ? `${MARKER} Replacement`
      : input.prompt?.includes('Versioned Employer')
        ? `${MARKER} Versioned Employer`
        : `${MARKER} Acme`;
    return {
      ok: true,
      object: {
        relationships: [
          {
            subject: { label: `${MARKER} Owner`, kind: 'person' },
            predicate: 'works_at',
            object: { label: employer, kind: 'organization' },
            evidenceQuote: `${MARKER} Owner works at ${employer}.`,
            confidence: 0.9,
          },
        ],
      },
    };
  },
} as unknown as ModelRouter;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        name: 'Knowledge Graph Test',
        email: `${MARKER}@example.com`,
        workspacePrefix: MARKER,
      })
      .returning({ id: agents.id });
    if (!agent) throw new Error('test agent was not created');
    agentId = agent.id;
    dbUp = true;
  } catch {
    console.warn('knowledge-graph.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    await db.delete(memories).where(like(memories.content, `${MARKER}%`));
    await db.delete(agents).where(eq(agents.id, agentId));
  }
  await (db as unknown as { $client?: { end: () => Promise<void> } }).$client?.end?.();
});

describe('knowledge graph sync and recall', () => {
  it('rejects a parsed relationship whose endpoints are not in its source fact', () => {
    expect(
      graphRelationshipIsGrounded('Anna works at Acme.', {
        subject: { label: 'Anna' },
        predicate: 'works_at',
        object: { label: 'Project Fox' },
        evidenceQuote: 'Anna works at Project Fox.',
      }),
    ).toBe(false);
    expect(
      graphRelationshipIsGrounded('Anna works at Acme.', {
        subject: { label: 'Anna' },
        predicate: 'works_at',
        object: { label: 'Acme' },
        evidenceQuote: 'Anna works at Acme.',
      }),
    ).toBe(true);
    expect(
      graphRelationshipIsGrounded('Anna visited Acme after working at Orbit.', {
        subject: { label: 'Anna' },
        predicate: 'works_at',
        object: { label: 'Acme' },
        evidenceQuote: 'Anna visited Acme',
      }),
    ).toBe(false);
  });

  it('backs facts into direct relations and expands a qualified seed by two hops', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [first] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Owner works at ${MARKER} Acme.`,
        contentHash: `${MARKER}-works`,
        embedding: unit(41),
        originTrust: 'owner',
      })
      .returning();
    await db.insert(memories).values({
      agentId,
      category: 'knowledge',
      kind: 'project',
      content: `${MARKER} Acme operates ${MARKER} Project Fox.`,
      contentHash: `${MARKER}-operates`,
      embedding: unit(42),
      originTrust: 'owner',
    });
    expect(first).toBeDefined();

    const synced = await syncKnowledgeGraph({ db, router }, { agentId });
    expect(synced.processed).toBeGreaterThanOrEqual(2);
    expect(synced.relationships).toBeGreaterThanOrEqual(2);

    const recalled = await recallKnowledgeGraph(db, {
      agentId,
      queryText: `${MARKER} where does the owner work`,
      queryEmbedding: unit(41),
    });
    expect(recalled.block).toContain('works at');
    expect(recalled.block).toContain('2 hops');
    expect(recalled.block).toContain(`${MARKER} Project Fox`);
    expect(recalled.sources.some((source) => source.kind === 'knowledge_graph')).toBe(true);
    expect(recalled.sources.some((source) => source.hops === 2)).toBe(true);
  });

  it('stores temporal qualifiers only when their wording is quoted and parseable', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Owner worked at ${MARKER} Acme from 2019 to March 2023. ${MARKER} Owner visited ${MARKER} Acme often.`,
        contentHash: `${MARKER}-qualifiers`,
        embedding: unit(44),
        originTrust: 'owner',
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('test memory was not created');

    const synced = await syncKnowledgeGraph({ db, router }, { agentId });
    expect(synced.relationships).toBeGreaterThanOrEqual(2);

    const relations = await db
      .select({
        predicate: knowledgeGraphRelations.predicate,
        validFrom: knowledgeGraphRelations.validFrom,
        validUntil: knowledgeGraphRelations.validUntil,
      })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.sourceMemoryId, memory.id));

    const worked = relations.find((row) => row.predicate === 'worked_at');
    expect(worked?.validFrom).toBe('2019');
    expect(worked?.validUntil).toBe('2023-03');

    // The edge survives; its ungrounded qualifiers do not.
    const visited = relations.find((row) => row.predicate === 'visited');
    expect(visited).toBeDefined();
    expect(visited?.validFrom).toBeNull();
    expect(visited?.validUntil).toBeNull();
  });

  it('re-extracts edited source content instead of retaining its old edge', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Owner works at ${MARKER} Original.`,
        contentHash: `${MARKER}-edited-original`,
        embedding: unit(43),
        originTrust: 'owner',
      })
      .returning();
    if (!memory) throw new Error('test memory was not created');
    await syncKnowledgeGraph({ db, router }, { agentId });

    await db
      .update(memories)
      .set({
        content: `${MARKER} Owner works at ${MARKER} Replacement.`,
        contentHash: `${MARKER}-edited-replacement`,
      })
      .where(eq(memories.id, memory.id));
    await syncKnowledgeGraph({ db, router }, { agentId });

    const relations = await db
      .select({ sourceMemoryId: knowledgeGraphRelations.sourceMemoryId })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.sourceMemoryId, memory.id));
    const [source] = await db
      .select({
        contentHash: knowledgeGraphSources.contentHash,
        status: knowledgeGraphSources.status,
      })
      .from(knowledgeGraphSources)
      .where(eq(knowledgeGraphSources.memoryId, memory.id));
    expect(relations).toHaveLength(1);
    expect(source).toEqual({ contentHash: `${MARKER}-edited-replacement`, status: 'ready' });
  });

  it('rebuilds legacy edges with quoted predicate evidence before recall uses them', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Owner works at ${MARKER} Versioned Employer.`,
        contentHash: `${MARKER}-legacy-evidence`,
        embedding: unit(50),
        originTrust: 'owner',
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('test memory was not created');
    await syncKnowledgeGraph({ db, router }, { agentId });
    await db
      .update(knowledgeGraphSources)
      .set({ extractionVersion: 1 })
      .where(eq(knowledgeGraphSources.memoryId, memory.id));
    await db
      .update(knowledgeGraphRelations)
      .set({ evidenceQuote: null })
      .where(eq(knowledgeGraphRelations.sourceMemoryId, memory.id));

    const legacyRecall = await recallKnowledgeGraph(db, {
      agentId,
      queryText: `${MARKER} versioned employer`,
      queryEmbedding: unit(50),
    });
    expect(legacyRecall.block).toBe('');

    const synced = await syncKnowledgeGraph({ db, router }, { agentId });
    expect(synced.processed).toBeGreaterThanOrEqual(1);
    const [source, relation] = await Promise.all([
      db
        .select({ extractionVersion: knowledgeGraphSources.extractionVersion })
        .from(knowledgeGraphSources)
        .where(eq(knowledgeGraphSources.memoryId, memory.id)),
      db
        .select({ evidenceQuote: knowledgeGraphRelations.evidenceQuote })
        .from(knowledgeGraphRelations)
        .where(eq(knowledgeGraphRelations.sourceMemoryId, memory.id)),
    ]);
    expect(source[0]?.extractionVersion).toBe(2);
    expect(relation[0]?.evidenceQuote).toContain(`${MARKER} Owner works at`);

    const recalled = await recallKnowledgeGraph(db, {
      agentId,
      queryText: `${MARKER} versioned employer`,
      queryEmbedding: unit(50),
    });
    expect(recalled.block).toContain(`${MARKER} Versioned Employer`);
  });

  it('recovers a source left pending by an interrupted graph sync', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Owner works at ${MARKER} Recovered Employer.`,
        contentHash: `${MARKER}-recovered-pending`,
        embedding: unit(48),
        originTrust: 'owner',
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('test memory was not created');
    await db.insert(knowledgeGraphSources).values({
      memoryId: memory.id,
      contentHash: `${MARKER}-recovered-pending`,
      status: 'pending',
      extractionVersion: 2,
      attempts: 1,
      updatedAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    const synced = await syncKnowledgeGraph({ db, router }, { agentId });
    const [source] = await db
      .select({ status: knowledgeGraphSources.status, attempts: knowledgeGraphSources.attempts })
      .from(knowledgeGraphSources)
      .where(eq(knowledgeGraphSources.memoryId, memory.id));
    expect(synced.processed).toBeGreaterThanOrEqual(1);
    expect(source).toEqual({ status: 'ready', attempts: 2 });
  });

  it('backs off transient extraction failures, quarantines a persistent one, and retries after an edit', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Owner works at ${MARKER} Retry Employer.`,
        contentHash: `${MARKER}-retry-backoff-v1`,
        embedding: unit(52),
        originTrust: 'owner',
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('test memory was not created');

    let calls = 0;
    const failingRouter = {
      async object() {
        calls += 1;
        throw new Error('temporary extraction provider outage');
      },
    } as unknown as ModelRouter;

    const first = await syncKnowledgeGraph({ db, router: failingRouter }, { agentId });
    expect(first.failed).toBe(1);
    let [source] = await db
      .select({
        status: knowledgeGraphSources.status,
        attempts: knowledgeGraphSources.attempts,
        nextRetryAt: knowledgeGraphSources.nextRetryAt,
      })
      .from(knowledgeGraphSources)
      .where(eq(knowledgeGraphSources.memoryId, memory.id));
    expect(source).toMatchObject({ status: 'failed', attempts: 1 });
    expect(source?.nextRetryAt?.getTime()).toBeGreaterThan(Date.now());

    // The scheduler runs frequently, but the provider is not retried until the
    // saved deadline. Force each deadline into the past to test the bounded
    // retry ladder without waiting for real time.
    for (let attempt = 2; attempt <= 4; attempt += 1) {
      await db
        .update(knowledgeGraphSources)
        .set({ nextRetryAt: new Date(Date.now() - 1) })
        .where(eq(knowledgeGraphSources.memoryId, memory.id));
      const result = await syncKnowledgeGraph({ db, router: failingRouter }, { agentId });
      [source] = await db
        .select({
          status: knowledgeGraphSources.status,
          attempts: knowledgeGraphSources.attempts,
          nextRetryAt: knowledgeGraphSources.nextRetryAt,
        })
        .from(knowledgeGraphSources)
        .where(eq(knowledgeGraphSources.memoryId, memory.id));
      expect(source?.attempts).toBe(attempt);
      if (attempt < 4) {
        expect(result.failed).toBe(1);
        expect(source?.status).toBe('failed');
        expect(source?.nextRetryAt?.getTime()).toBeGreaterThan(Date.now());
      } else {
        expect(result.quarantined).toBe(1);
        expect(source).toMatchObject({ status: 'quarantined', nextRetryAt: null });
      }
    }
    expect(calls).toBe(4);
    const paused = await syncKnowledgeGraph({ db, router: failingRouter }, { agentId });
    expect(paused.candidates).toBe(0);
    expect(calls).toBe(4);

    // A source edit is a new fact. It clears the terminal checkpoint and gets
    // one fresh extraction attempt instead of requiring an operator to touch DB.
    await db
      .update(memories)
      .set({
        content: `${MARKER} Owner works at ${MARKER} Retry Employer Updated.`,
        contentHash: `${MARKER}-retry-backoff-v2`,
      })
      .where(eq(memories.id, memory.id));
    const recovered = await syncKnowledgeGraph({ db, router }, { agentId });
    const [recoveredSource] = await db
      .select({ status: knowledgeGraphSources.status, attempts: knowledgeGraphSources.attempts })
      .from(knowledgeGraphSources)
      .where(eq(knowledgeGraphSources.memoryId, memory.id));
    expect(recovered.processed).toBe(1);
    expect(recoveredSource).toEqual({ status: 'ready', attempts: 1 });
  });

  it('lets the owner resume quarantined sources without rewriting the source fact', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Owner works at ${MARKER} Manually Retried Employer.`,
        contentHash: `${MARKER}-manual-retry`,
        embedding: unit(53),
        originTrust: 'owner',
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('test memory was not created');
    await db.insert(knowledgeGraphSources).values({
      memoryId: memory.id,
      contentHash: `${MARKER}-manual-retry`,
      extractionVersion: 2,
      status: 'quarantined',
      attempts: 4,
      lastError: 'previous provider outage',
    });

    expect(await retryQuarantinedKnowledgeGraphSources(db, agentId)).toBe(1);
    const [requested] = await db
      .select({
        status: knowledgeGraphSources.status,
        attempts: knowledgeGraphSources.attempts,
        nextRetryAt: knowledgeGraphSources.nextRetryAt,
      })
      .from(knowledgeGraphSources)
      .where(eq(knowledgeGraphSources.memoryId, memory.id));
    expect(requested).toMatchObject({ status: 'failed', attempts: 0 });
    expect(requested?.nextRetryAt?.getTime()).toBeLessThanOrEqual(Date.now());

    const synced = await syncKnowledgeGraph({ db, router }, { agentId });
    const [recovered] = await db
      .select({ status: knowledgeGraphSources.status, attempts: knowledgeGraphSources.attempts })
      .from(knowledgeGraphSources)
      .where(eq(knowledgeGraphSources.memoryId, memory.id));
    expect(synced.processed).toBe(1);
    expect(recovered).toEqual({ status: 'ready', attempts: 1 });
  });

  it('lets one overlapping sync claim a source', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Owner works at ${MARKER} Concurrent Employer.`,
        contentHash: `${MARKER}-concurrent-claim`,
        embedding: unit(49),
        originTrust: 'owner',
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('test memory was not created');

    let calls = 0;
    const slowRouter = {
      async object() {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          ok: true,
          object: {
            relationships: [
              {
                subject: { label: `${MARKER} Owner`, kind: 'person' },
                predicate: 'works_at',
                object: { label: `${MARKER} Concurrent Employer`, kind: 'organization' },
                evidenceQuote: `${MARKER} Owner works at ${MARKER} Concurrent Employer.`,
                confidence: 0.9,
              },
            ],
          },
        };
      },
    } as unknown as ModelRouter;
    const [first, second] = await Promise.all([
      syncKnowledgeGraph({ db, router: slowRouter }, { agentId }),
      syncKnowledgeGraph({ db, router: slowRouter }, { agentId }),
    ]);

    expect(calls).toBe(1);
    expect(first.processed + second.processed).toBe(1);
  });

  it('keeps an owner-rejected edge out of recall and writes owner facts with evidence', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const saved = await createOwnerKnowledgeGraphFact(
      {
        db,
        agentId,
        router: {
          async embed() {
            return [unit(46)];
          },
        },
      },
      {
        subject: { label: `${MARKER} Owner`, kind: 'person' },
        predicate: 'owns',
        object: { label: `${MARKER} Manual Project`, kind: 'project' },
        note: 'I created this project and want it remembered.',
      },
    );
    expect(saved.error).toBeUndefined();
    if (!saved.memoryId || !saved.relationId) throw new Error('manual graph fact was not saved');

    const [source, relation] = await Promise.all([
      db
        .select({ status: knowledgeGraphSources.status })
        .from(knowledgeGraphSources)
        .where(eq(knowledgeGraphSources.memoryId, saved.memoryId)),
      db
        .select({ reviewStatus: knowledgeGraphRelations.reviewStatus })
        .from(knowledgeGraphRelations)
        .where(eq(knowledgeGraphRelations.id, saved.relationId)),
    ]);
    expect(source[0]?.status).toBe('ready');
    expect(relation[0]?.reviewStatus).toBe('confirmed');

    await db
      .update(knowledgeGraphRelations)
      .set({ reviewStatus: 'rejected' })
      .where(eq(knowledgeGraphRelations.id, saved.relationId));
    const recalled = await recallKnowledgeGraph(db, {
      agentId,
      queryText: `${MARKER} manual project`,
      queryEmbedding: unit(46),
    });
    expect(recalled.block).not.toContain(`${MARKER} Manual Project`);
  });

  it('retains a matching owner decision when its source is re-extracted', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Owner works at ${MARKER} Acme.`,
        contentHash: `${MARKER}-reviewed-source-v1`,
        embedding: unit(47),
        originTrust: 'owner',
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('test memory was not created');
    await syncKnowledgeGraph({ db, router }, { agentId });
    const [edge] = await db
      .select({ id: knowledgeGraphRelations.id })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.sourceMemoryId, memory.id));
    if (!edge) throw new Error('graph relationship was not created');
    await db
      .update(knowledgeGraphRelations)
      .set({ reviewStatus: 'rejected' })
      .where(eq(knowledgeGraphRelations.id, edge.id));

    await db
      .update(memories)
      .set({
        content: `${MARKER} Owner works at ${MARKER} Acme. This is current.`,
        contentHash: `${MARKER}-reviewed-source-v2`,
      })
      .where(eq(memories.id, memory.id));
    await syncKnowledgeGraph({ db, router }, { agentId });
    const [reextracted] = await db
      .select({ reviewStatus: knowledgeGraphRelations.reviewStatus })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.sourceMemoryId, memory.id));
    expect(reextracted?.reviewStatus).toBe('rejected');
  });

  // Date entities used to be whatever the extractor said, so "Friday", "next
  // Friday" and "2026-03-06" were three permanent, unmergeable nodes.
  it('collapses differently worded dates onto one canonical entity', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const recordedAt = new Date('2026-03-04T12:00:00Z');
    const content = `${MARKER} Dana meets the board on Friday.`;
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content,
        contentHash: `${MARKER}-date-1`,
        embedding: unit(60),
        confidence: '0.90',
        createdAt: recordedAt,
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('fixture memory was not created');

    const dateRouter = {
      async object() {
        return {
          ok: true,
          object: {
            relationships: [
              {
                subject: { label: `${MARKER} Dana`, kind: 'person' },
                predicate: 'meets_the_board_on',
                object: { label: 'Friday', kind: 'date' },
                evidenceQuote: `${MARKER} Dana meets the board on Friday`,
                confidence: 0.9,
              },
            ],
          },
        };
      },
    } as unknown as ModelRouter;
    await syncKnowledgeGraph({ db, router: dateRouter }, { agentId, limit: 5 });

    const [dateEntity] = await db
      .select({ key: knowledgeGraphEntities.canonicalKey, label: knowledgeGraphEntities.label })
      .from(knowledgeGraphEntities)
      .where(
        and(eq(knowledgeGraphEntities.agentId, agentId), eq(knowledgeGraphEntities.kind, 'date')),
      );
    // Resolved against the memory's own timestamp, not against "now".
    expect(dateEntity?.key).toBe('date:2026-03-06');
    expect(dateEntity?.label).not.toBe('Friday');
  });

  it('drops an edge whose date cannot be pinned down rather than storing the wording', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const content = `${MARKER} Ezra ships the rewrite eventually.`;
    await db.insert(memories).values({
      agentId,
      category: 'knowledge',
      kind: 'fact',
      content,
      contentHash: `${MARKER}-date-2`,
      embedding: unit(61),
      confidence: '0.90',
    });
    const vagueRouter = {
      async object() {
        return {
          ok: true,
          object: {
            relationships: [
              {
                subject: { label: `${MARKER} Ezra`, kind: 'person' },
                predicate: 'ships_the_rewrite',
                object: { label: 'eventually', kind: 'date' },
                evidenceQuote: `${MARKER} Ezra ships the rewrite eventually`,
                confidence: 0.9,
              },
            ],
          },
        };
      },
    } as unknown as ModelRouter;
    await syncKnowledgeGraph({ db, router: vagueRouter }, { agentId, limit: 5 });

    const stored = await db
      .select({ label: knowledgeGraphEntities.label })
      .from(knowledgeGraphEntities)
      .where(
        and(eq(knowledgeGraphEntities.agentId, agentId), eq(knowledgeGraphEntities.kind, 'date')),
      );
    expect(stored.map((row) => row.label)).not.toContain('eventually');
  });

  // The label was rewritten on every extraction, so the displayed name changed
  // with whichever run happened last while the identity underneath never did.
  it('keeps the better-cased label when a re-extraction spells it differently', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const content = `${MARKER} Fern works at ${MARKER} Northwind.`;
    await db.insert(memories).values({
      agentId,
      category: 'knowledge',
      kind: 'fact',
      content,
      contentHash: `${MARKER}-case-1`,
      embedding: unit(62),
      confidence: '0.90',
    });
    const casedRouter = (label: string) =>
      ({
        async object() {
          return {
            ok: true,
            object: {
              relationships: [
                {
                  subject: { label: `${MARKER} Fern`, kind: 'person' },
                  predicate: 'works_at',
                  object: { label, kind: 'organization' },
                  evidenceQuote: `${MARKER} Fern works at ${MARKER} Northwind`,
                  confidence: 0.9,
                },
              ],
            },
          };
        },
      }) as unknown as ModelRouter;

    await syncKnowledgeGraph({ db, router: casedRouter(`${MARKER} Northwind`) }, { agentId });
    // Force a re-extraction of the same source with a worse spelling.
    const [cased] = await db
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.contentHash, `${MARKER}-case-1`))
      .limit(1);
    if (!cased) throw new Error('fixture memory was not found');
    await db
      .update(knowledgeGraphSources)
      .set({ status: 'failed', nextRetryAt: new Date(), attempts: 0 })
      .where(eq(knowledgeGraphSources.memoryId, cased.id));
    await syncKnowledgeGraph(
      { db, router: casedRouter(`${MARKER.toLowerCase()} northwind`) },
      { agentId },
    );

    const [org] = await db
      .select({ label: knowledgeGraphEntities.label })
      .from(knowledgeGraphEntities)
      .where(
        and(
          eq(knowledgeGraphEntities.agentId, agentId),
          eq(
            knowledgeGraphEntities.canonicalKey,
            `organization:${normalizedKey(MARKER)} northwind`,
          ),
        ),
      );
    expect(org?.label).toBe(`${MARKER} Northwind`);
  });

  it('canonicalizes existing date entities without calling a model', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // backfillKnowledgeGraphDates takes no router at all — being unable to make
    // a model call is a property of its signature, not of this fixture.
    const recordedAt = new Date('2026-03-04T12:00:00Z');
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Gale lands on 2026-03-06.`,
        contentHash: `${MARKER}-backfill-1`,
        embedding: unit(63),
        confidence: '0.90',
        createdAt: recordedAt,
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('fixture memory was not created');

    // Two spellings of the same day, as the old extractor would have left them.
    const [legacy] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: 'date:friday',
        label: 'Friday',
        kind: 'date',
      })
      .returning({ id: knowledgeGraphEntities.id });
    const [iso] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: 'date:6 march 2026',
        label: '6 March 2026',
        kind: 'date',
      })
      .returning({ id: knowledgeGraphEntities.id });
    const [person] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: `person:${MARKER.toLowerCase()} gale`,
        label: `${MARKER} Gale`,
        kind: 'person',
      })
      .returning({ id: knowledgeGraphEntities.id });
    if (!legacy || !iso || !person) throw new Error('fixture entities were not created');

    for (const [index, target] of [legacy, iso].entries()) {
      await db.insert(knowledgeGraphRelations).values({
        agentId,
        subjectEntityId: person.id,
        predicate: 'lands_on',
        objectEntityId: target.id,
        sourceMemoryId: memory.id,
        evidenceQuote: `${MARKER} Gale lands on 2026-03-06`,
        sourceFingerprint: `${MARKER}-backfill-fp-${index}`,
        ordinal: index + 1,
        confidence: '0.90',
      });
    }

    const result = await backfillKnowledgeGraphDates(db, { agentId });
    expect(result.scanned).toBeGreaterThanOrEqual(2);
    expect(result.merged).toBeGreaterThanOrEqual(1);

    const dates = await db
      .select({ key: knowledgeGraphEntities.canonicalKey })
      .from(knowledgeGraphEntities)
      .where(
        and(eq(knowledgeGraphEntities.agentId, agentId), eq(knowledgeGraphEntities.kind, 'date')),
      );
    // Both spellings now point at the same canonical day.
    expect(dates.filter((row) => row.key === 'date:2026-03-06')).toHaveLength(1);
    expect(dates.map((row) => row.key)).not.toContain('date:friday');
  });

  // A relative label means a different day depending on when it was written,
  // and one entity is shared by every memory that used that wording. Resolving
  // it against the earliest citation alone would repoint a later memory's edge
  // to a day that memory never meant.
  it('leaves a shared relative date alone when its sources would disagree', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [early] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Iris presents on Friday.`,
        contentHash: `${MARKER}-shared-1`,
        embedding: unit(65),
        confidence: '0.90',
        createdAt: new Date('2026-03-04T12:00:00Z'),
      })
      .returning({ id: memories.id });
    const [late] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Jonah travels on Friday.`,
        contentHash: `${MARKER}-shared-2`,
        embedding: unit(66),
        confidence: '0.90',
        // Five weeks later — a different Friday entirely.
        createdAt: new Date('2026-04-08T12:00:00Z'),
      })
      .returning({ id: memories.id });
    const [shared] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: `date:${MARKER} friday`,
        label: 'Friday',
        kind: 'date',
      })
      .returning({ id: knowledgeGraphEntities.id });
    const [who] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: `person:${MARKER} iris`,
        label: `${MARKER} Iris`,
        kind: 'person',
      })
      .returning({ id: knowledgeGraphEntities.id });
    if (!early || !late || !shared || !who) throw new Error('fixtures were not created');

    for (const [index, source] of [early, late].entries()) {
      await db.insert(knowledgeGraphRelations).values({
        agentId,
        subjectEntityId: who.id,
        predicate: 'happens_on',
        objectEntityId: shared.id,
        sourceMemoryId: source.id,
        evidenceQuote: 'on Friday',
        sourceFingerprint: `${MARKER}-shared-fp-${index}`,
        ordinal: index + 1,
        confidence: '0.90',
      });
    }

    await backfillKnowledgeGraphDates(db, { agentId });

    const [after] = await db
      .select({ key: knowledgeGraphEntities.canonicalKey })
      .from(knowledgeGraphEntities)
      .where(eq(knowledgeGraphEntities.id, shared.id));
    // Untouched: no single rewrite is right for both, so it is left for the
    // anchored re-extraction, which resolves per source.
    expect(after?.key).toBe(`date:${MARKER} friday`);
  });

  // An absolute label lands on the same key from either end of the window, so
  // sharing it across memories is harmless and it must still be canonicalized.
  it('still canonicalizes an absolute date shared by memories from different days', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [first] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Kit files on 2026-05-01.`,
        contentHash: `${MARKER}-abs-1`,
        embedding: unit(67),
        confidence: '0.90',
        createdAt: new Date('2026-03-04T12:00:00Z'),
      })
      .returning({ id: memories.id });
    const [second] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Lena reviews on 2026-05-01.`,
        contentHash: `${MARKER}-abs-2`,
        embedding: unit(68),
        confidence: '0.90',
        createdAt: new Date('2026-04-08T12:00:00Z'),
      })
      .returning({ id: memories.id });
    const [absolute] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: `date:${MARKER} 1 may 2026`,
        label: '1 May 2026',
        kind: 'date',
      })
      .returning({ id: knowledgeGraphEntities.id });
    const [actor] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: `person:${MARKER} kit`,
        label: `${MARKER} Kit`,
        kind: 'person',
      })
      .returning({ id: knowledgeGraphEntities.id });
    if (!first || !second || !absolute || !actor) throw new Error('fixtures were not created');

    for (const [index, source] of [first, second].entries()) {
      await db.insert(knowledgeGraphRelations).values({
        agentId,
        subjectEntityId: actor.id,
        predicate: 'acts_on',
        objectEntityId: absolute.id,
        sourceMemoryId: source.id,
        evidenceQuote: 'on 2026-05-01',
        sourceFingerprint: `${MARKER}-abs-fp-${index}`,
        ordinal: index + 1,
        confidence: '0.90',
      });
    }

    await backfillKnowledgeGraphDates(db, { agentId });

    const [after] = await db
      .select({ key: knowledgeGraphEntities.canonicalKey })
      .from(knowledgeGraphEntities)
      .where(eq(knowledgeGraphEntities.id, absolute.id));
    expect(after?.key).toBe('date:2026-05-01');
  });

  // The paid pass is only worth offering for sources the free one could not
  // fix, so a source that already carries a canonical date must not be counted.
  it('counts only the sources whose dates the free backfill could not fix', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const before = await countRelativeDateSources(db, agentId);

    const [stranded] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Hana said she would call next week.`,
        contentHash: `${MARKER}-relative-1`,
        embedding: unit(64),
        confidence: '0.90',
      })
      .returning({ id: memories.id });
    if (!stranded) throw new Error('fixture memory was not created');
    // A ready checkpoint with no date entity behind it — exactly the shape the
    // anchored prompt exists to rescue.
    await db.insert(knowledgeGraphSources).values({
      memoryId: stranded.id,
      contentHash: `${MARKER}-relative-1`,
      extractionVersion: GRAPH_EXTRACTION_VERSION,
      status: 'ready',
    });

    expect(await countRelativeDateSources(db, agentId)).toBe(before + 1);
  });
});
