import {
  agents,
  createDb,
  type Db,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
} from '@assistant/db';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelRouter } from '../model-router/router.js';
import { recallKnowledgeGraph } from './graph-recall.js';
import {
  createOwnerKnowledgeGraphFact,
  graphRelationshipIsGrounded,
  retryQuarantinedKnowledgeGraphSources,
  syncKnowledgeGraph,
} from './knowledge-graph.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-graph-${Date.now()}`;

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
});
