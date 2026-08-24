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
import { graphRelationshipIsGrounded, syncKnowledgeGraph } from './knowledge-graph.js';

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
              confidence: 0.9,
            },
          ],
        },
      };
    }
    const employer = input.prompt?.includes('Replacement')
      ? `${MARKER} Replacement`
      : `${MARKER} Acme`;
    return {
      ok: true,
      object: {
        relationships: [
          {
            subject: { label: `${MARKER} Owner`, kind: 'person' },
            predicate: 'works_at',
            object: { label: employer, kind: 'organization' },
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
        object: { label: 'Project Fox' },
      }),
    ).toBe(false);
    expect(
      graphRelationshipIsGrounded('Anna works at Acme.', {
        subject: { label: 'Anna' },
        object: { label: 'Acme' },
      }),
    ).toBe(true);
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
});
