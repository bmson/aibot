import { getAgent } from '@assistant/core/chat';
import { agents, createDb, type Db, knowledgeGraphSources, memories, tasks } from '@assistant/db';
import { and, eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveQuarantinedMemory,
  correctMemory,
  forgetMemory,
  restoreMemory,
} from './commands.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-memory-correction-${Date.now()}`;

let db: Db;
let dbUp = false;
let agentId: string;
let memoryId: string;
let createdAgentId: string | null = null;

function unitVector(): number[] {
  const vector = new Array(1536).fill(0);
  vector[0] = 1;
  return vector;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    try {
      agentId = (await getAgent(db)).id;
    } catch {
      const [agent] = await db
        .insert(agents)
        .values({
          name: 'Memory Correction Test',
          email: `${MARKER}@example.com`,
          workspacePrefix: MARKER,
        })
        .returning({ id: agents.id });
      if (!agent) throw new Error('test agent was not created');
      agentId = agent.id;
      createdAgentId = agent.id;
    }
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} original fact`,
        contentHash: `${MARKER}-original`,
        confidence: '0.70',
        embedding: unitVector(),
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('test memory was not created');
    memoryId = memory.id;
    dbUp = true;
  } catch {
    console.warn('profile/commands.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    await db.delete(memories).where(eq(memories.id, memoryId));
    await db.delete(tasks).where(eq(tasks.agentId, agentId));
    if (createdAgentId) await db.delete(agents).where(eq(agents.id, createdAgentId));
  }
  await (db as unknown as { $client?: { end: () => Promise<void> } }).$client?.end?.();
});

describe('memory correction graph refresh (integration)', () => {
  it('queues one graph refresh for a corrected source and reuses it for repeated edits', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const router = { embed: async () => [unitVector()] };
    expect(
      (await correctMemory(db, router, memoryId, `${MARKER} corrected fact`)).error,
    ).toBeUndefined();
    expect(
      (await correctMemory(db, router, memoryId, `${MARKER} corrected again`)).error,
    ).toBeUndefined();

    const queued = await db
      .select({ id: tasks.id, job: sql<string>`${tasks.trigger} #>> '{payload,job}'` })
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agentId),
          like(tasks.externalEventId, `profile:graph-sync:${memoryId}%`),
        ),
      );
    expect(queued).toHaveLength(1);
    expect(queued[0]?.job).toBe('memory.graph_sync');
  });

  it('restores an expired source when its owner keeps it current', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await db.delete(tasks).where(eq(tasks.agentId, agentId));
    await db
      .update(memories)
      .set({
        expiresAt: sql`now() - interval '1 second'`,
        quarantined: true,
        ownerConfirmed: false,
      })
      .where(eq(memories.id, memoryId));

    await restoreMemory(db, memoryId);

    const [restored] = await db
      .select({
        expiresAt: memories.expiresAt,
        supersededById: memories.supersededById,
        quarantined: memories.quarantined,
        ownerConfirmed: memories.ownerConfirmed,
      })
      .from(memories)
      .where(eq(memories.id, memoryId));
    expect(restored).toMatchObject({
      expiresAt: null,
      supersededById: null,
      quarantined: false,
      ownerConfirmed: true,
    });
    const queued = await db
      .select({ id: tasks.id, job: sql<string>`${tasks.trigger} #>> '{payload,job}'` })
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agentId),
          like(tasks.externalEventId, `profile:graph-sync:${memoryId}%`),
        ),
      );
    expect(queued).toHaveLength(1);
    expect(queued[0]?.job).toBe('memory.graph_sync');
  });

  it('approves a source, retries a blocked projection, and queues one refresh', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await db.delete(tasks).where(eq(tasks.agentId, agentId));
    const [memory] = await db
      .select({ contentHash: memories.contentHash })
      .from(memories)
      .where(eq(memories.id, memoryId));
    if (!memory) throw new Error('test memory was not created');
    await db.update(memories).set({ quarantined: true }).where(eq(memories.id, memoryId));
    await db
      .insert(knowledgeGraphSources)
      .values({ memoryId, contentHash: memory.contentHash, status: 'quarantined', attempts: 4 })
      .onConflictDoUpdate({
        target: knowledgeGraphSources.memoryId,
        set: { contentHash: memory.contentHash, status: 'quarantined', attempts: 4 },
      });

    await approveQuarantinedMemory(db, memoryId);

    const [[approved], [source], queued] = await Promise.all([
      db
        .select({ quarantined: memories.quarantined })
        .from(memories)
        .where(eq(memories.id, memoryId)),
      db
        .select({
          status: knowledgeGraphSources.status,
          attempts: knowledgeGraphSources.attempts,
          nextRetryAt: knowledgeGraphSources.nextRetryAt,
        })
        .from(knowledgeGraphSources)
        .where(eq(knowledgeGraphSources.memoryId, memoryId)),
      db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, agentId),
            like(tasks.externalEventId, `profile:graph-sync:${memoryId}%`),
          ),
        ),
    ]);
    expect(approved?.quarantined).toBe(false);
    expect(source).toMatchObject({ status: 'failed', attempts: 0 });
    expect(source?.nextRetryAt?.getTime()).toBeLessThanOrEqual(Date.now());
    expect(queued).toHaveLength(1);
  });

  it('queues a fresh graph source when approval has no existing checkpoint', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await db.delete(tasks).where(eq(tasks.agentId, agentId));
    await db.delete(knowledgeGraphSources).where(eq(knowledgeGraphSources.memoryId, memoryId));
    await db.update(memories).set({ quarantined: true }).where(eq(memories.id, memoryId));

    await approveQuarantinedMemory(db, memoryId);

    const [source, queued] = await Promise.all([
      db
        .select({ memoryId: knowledgeGraphSources.memoryId })
        .from(knowledgeGraphSources)
        .where(eq(knowledgeGraphSources.memoryId, memoryId)),
      db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, agentId),
            like(tasks.externalEventId, `profile:graph-sync:${memoryId}%`),
          ),
        ),
    ]);
    expect(source).toEqual([]);
    expect(queued).toHaveLength(1);
  });

  it('never mutates a memory owned by a different agent', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [otherAgent] = await db
      .insert(agents)
      .values({
        name: 'Foreign Memory Test',
        email: `${MARKER}-foreign@example.com`,
        workspacePrefix: `${MARKER}-foreign`,
      })
      .returning({ id: agents.id });
    if (!otherAgent) throw new Error('foreign test agent was not created');
    const [foreignMemory] = await db
      .insert(memories)
      .values({
        agentId: otherAgent.id,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} foreign fact`,
        contentHash: `${MARKER}-foreign`,
        confidence: '0.70',
        quarantined: true,
        embedding: unitVector(),
      })
      .returning({ id: memories.id });
    if (!foreignMemory) throw new Error('foreign test memory was not created');

    try {
      expect(
        (
          await correctMemory(
            db,
            { embed: async () => [unitVector()] },
            foreignMemory.id,
            'changed',
          )
        ).error,
      ).toBe('Fact not found.');
      await approveQuarantinedMemory(db, foreignMemory.id);
      await forgetMemory(db, foreignMemory.id);
      const [stored] = await db
        .select({ quarantined: memories.quarantined, content: memories.content })
        .from(memories)
        .where(eq(memories.id, foreignMemory.id));
      expect(stored).toMatchObject({ quarantined: true, content: `${MARKER} foreign fact` });
    } finally {
      await db.delete(memories).where(eq(memories.id, foreignMemory.id));
      await db.delete(agents).where(eq(agents.id, otherAgent.id));
    }
  });
});
