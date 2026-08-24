import {
  agents,
  conversations,
  createDb,
  type Db,
  knowledgeGraphSources,
  memories,
  messages,
  responseChecks,
  tasks,
} from '@assistant/db';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAssistantHealthMonitor } from './health-monitor.js';
import { enqueueTask } from './machine.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-health-monitor-${Date.now()}`;

let db: Db;
let dbUp = false;
let agentId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        name: 'Health Monitor Test',
        email: `${MARKER}@example.com`,
        workspacePrefix: MARKER,
      })
      .returning({ id: agents.id });
    if (!agent) throw new Error('test agent was not created');
    agentId = agent.id;
    dbUp = true;
  } catch {
    console.warn('health-monitor.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    const rows = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.agentId, agentId));
    if (rows.length) {
      await db.delete(messages).where(
        inArray(
          messages.conversationId,
          rows.map((row) => row.id),
        ),
      );
      await db.delete(conversations).where(eq(conversations.agentId, agentId));
    }
    await db.delete(memories).where(eq(memories.agentId, agentId));
    await db.delete(tasks).where(eq(tasks.agentId, agentId));
    await db.delete(agents).where(eq(agents.id, agentId));
  }
  await (db as unknown as { $client?: { end: () => Promise<void> } }).$client?.end?.();
});

describe('assistant health monitor (integration)', () => {
  it('stays quiet for a healthy agent', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await runAssistantHealthMonitor({ db }, { agentId });
    expect(result).toEqual({ signals: [], notified: false });
  });

  it('notifies the owner about quarantined GraphRAG and repeated response-quality failures', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} quarantined source`,
        contentHash: `${MARKER}-quarantined`,
        embedding: new Array(1536).fill(0.01),
        originTrust: 'owner',
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('test memory was not created');
    await db.insert(knowledgeGraphSources).values({
      memoryId: memory.id,
      contentHash: `${MARKER}-quarantined`,
      status: 'quarantined',
      attempts: 4,
      lastError: 'provider outage',
    });

    for (let i = 0; i < 2; i += 1) {
      const { task } = await enqueueTask(db, {
        event: {
          source: 'internal',
          externalEventId: `${MARKER}-quality-${i}`,
          agentId,
          trust: 'assistant',
          payload: {},
        },
        type: 'adhoc',
      });
      await db.insert(responseChecks).values({
        taskId: task.id,
        promptVersion: 1,
        outputVerificationUnavailable: true,
        mustActRetries: 1,
      });
    }

    const result = await runAssistantHealthMonitor({ db }, { agentId });
    expect(result.notified).toBe(true);
    expect(result.signals).toHaveLength(3);
    const [notice] = await db
      .select({ text: messages.text })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(eq(conversations.agentId, agentId), eq(conversations.title, 'Notifications')))
      .orderBy(messages.createdAt);
    expect(notice?.text).toContain('quarantined after bounded retries');
    expect(notice?.text).toContain('verification was unavailable 2 times');
    expect(notice?.text).toContain('2 required-action steps');
  });
});
