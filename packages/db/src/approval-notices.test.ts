import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createPostgresApprovalRepository } from './approval-repository.js';
import { createDb } from './client.js';
import { agents, approvals, conversations, tasks, toolCalls } from './schema.js';

const DATABASE_URL = process.env.DATABASE_URL;

function testDatabaseUrl(): string {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
}

async function fixture() {
  const db = createDb(testDatabaseUrl());
  const [agent] = await db.select().from(agents).limit(1);
  if (!agent) throw new Error('Seed the test database');
  const taskIds: string[] = [];
  const toolCallIds: string[] = [];
  const approvalIds: string[] = [];
  const conversationIds: string[] = [];
  return {
    db,
    agentId: agent.id,
    repository: createPostgresApprovalRepository(db),
    async task(options: { status?: string; conversationId?: string | null } = {}) {
      const id = randomUUID();
      await db.insert(tasks).values({
        id,
        agentId: agent.id,
        type: 'adhoc',
        trust: 'assistant',
        status: options.status ?? 'waiting_approval',
        conversationId: options.conversationId,
      });
      taskIds.push(id);
      return id;
    },
    async conversation() {
      const id = randomUUID();
      await db.insert(conversations).values({
        id,
        agentId: agent.id,
        channel: 'chat',
        trust: 'owner',
      });
      conversationIds.push(id);
      return id;
    },
    async approval(
      taskId: string,
      options: {
        id?: string;
        toolCallId?: string;
        shortCode?: string;
        status?: string;
        requestedAt?: Date;
        notifiedChannels?: string[];
        toolName?: string;
      } = {},
    ) {
      const id = options.id ?? randomUUID();
      const toolCallId = options.toolCallId ?? randomUUID();
      await db.insert(toolCalls).values({
        id: toolCallId,
        taskId,
        step: 0,
        toolName: options.toolName ?? 'test.approval',
        risk: 'approval',
        status:
          options.status === 'pending' || !options.status ? 'awaiting_approval' : options.status,
      });
      await db.insert(approvals).values({
        id,
        taskId,
        toolCallId,
        shortCode: options.shortCode ?? `T${id.slice(0, 8)}`,
        summary: 'notice test approval',
        payload: { value: 'test' },
        status: options.status ?? 'pending',
        requestedAt: options.requestedAt,
        expiresAt: new Date('2026-09-13T12:00:00.000Z'),
        notifiedChannels: options.notifiedChannels ?? [],
      });
      toolCallIds.push(toolCallId);
      approvalIds.push(id);
      return { id, toolCallId };
    },
    trackCreated(rows: Array<{ approvalId: string; toolCallId: string }>) {
      approvalIds.push(...rows.map((row) => row.approvalId));
      toolCallIds.push(...rows.map((row) => row.toolCallId));
    },
    async dispose() {
      if (toolCallIds.length)
        await db
          .update(toolCalls)
          .set({ approvalId: null })
          .where(inArray(toolCalls.id, toolCallIds));
      if (approvalIds.length) await db.delete(approvals).where(inArray(approvals.id, approvalIds));
      if (toolCallIds.length) await db.delete(toolCalls).where(inArray(toolCalls.id, toolCallIds));
      if (taskIds.length) await db.delete(tasks).where(inArray(tasks.id, taskIds));
      if (conversationIds.length)
        await db.delete(conversations).where(inArray(conversations.id, conversationIds));
      await db.$client.end();
    },
  };
}

it('creates linked approval records atomically with historical monotonic random codes', async () => {
  const f = await fixture();
  try {
    const historicalTask = await f.task({ status: 'pending' });
    await f.approval(historicalTask, {
      shortCode: 'A900000ZZ',
      status: 'approved',
      toolName: 'test.historical',
    });
    const firstTask = await f.task({ status: 'pending' });
    const secondTask = await f.task({ status: 'pending' });
    const input = (taskId: string) => ({
      taskId,
      step: 4,
      toolName: 'test.dispatch',
      args: { recipient: 'owner' },
      decision: { riskTier: 'high', reason: 'test' },
      summary: 'Please approve this test action',
    });

    const created = await Promise.all([
      f.repository.create(input(firstTask)),
      f.repository.create(input(secondTask)),
    ]);
    f.trackCreated(created);
    const codes = created.map((row) => row.shortCode).sort();
    expect(codes[0]).toMatch(/^A900001[A-HJ-NP-Z]{2}$/);
    expect(codes[1]).toMatch(/^A900002[A-HJ-NP-Z]{2}$/);
    for (const row of created) {
      const [toolCall] = await f.db
        .select()
        .from(toolCalls)
        .where(eq(toolCalls.id, row.toolCallId));
      const [approval] = await f.db
        .select()
        .from(approvals)
        .where(eq(approvals.id, row.approvalId));
      expect(toolCall).toMatchObject({
        taskId: expect.any(String),
        status: 'awaiting_approval',
        risk: 'approval',
        approvalId: row.approvalId,
      });
      expect(approval).toMatchObject({
        taskId: toolCall?.taskId,
        toolCallId: row.toolCallId,
        status: 'pending',
        summary: 'Please approve this test action',
      });
      expect(approval?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    }
  } finally {
    await f.dispose();
  }
});

it('lists old pending notices by task, preserving notice order and filters', async () => {
  const f = await fixture();
  const now = new Date('2026-09-12T12:00:00.000Z');
  try {
    const conversationId = await f.conversation();
    const groupedTask = await f.task({ conversationId });
    const first = await f.approval(groupedTask, {
      requestedAt: new Date('2026-09-12T11:00:00.000Z'),
      toolName: 'test.first',
    });
    const second = await f.approval(groupedTask, {
      requestedAt: new Date('2026-09-12T11:01:00.000Z'),
      toolName: 'test.second',
      notifiedChannels: ['owner'],
    });
    const notified = await f.approval(groupedTask, {
      requestedAt: new Date('2026-09-12T11:02:00.000Z'),
      notifiedChannels: ['conversation'],
    });
    const future = await f.approval(groupedTask, {
      requestedAt: new Date('2026-09-12T11:59:00.000Z'),
    });
    const doneTask = await f.task({ status: 'done' });
    const done = await f.approval(doneTask, {
      requestedAt: new Date('2026-09-12T11:00:00.000Z'),
      status: 'approved',
    });

    const groups = await f.repository.listStalledNotices({ batch: 50, olderThanMinutes: 5, now });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.task.id).toBe(groupedTask);
    expect(groups[0]?.notices.map((notice) => notice.id)).toEqual([first.id, second.id]);
    expect(groups[0]?.notices.map((notice) => notice.toolName)).toEqual([
      'test.first',
      'test.second',
    ]);
    expect(groups[0]?.notices.map((notice) => notice.id)).not.toContain(notified.id);
    expect(groups[0]?.notices.map((notice) => notice.id)).not.toContain(future.id);
    expect(groups[0]?.notices.map((notice) => notice.id)).not.toContain(done.id);
  } finally {
    await f.dispose();
  }
});

it('unions concurrent notification legs and leaves terminal approvals unchanged', async () => {
  const f = await fixture();
  try {
    const taskId = await f.task();
    const row = await f.approval(taskId, { notifiedChannels: ['custom'] });
    await Promise.all([
      f.repository.markNotified([row.id], ['owner']),
      f.repository.markNotified([row.id], ['conversation']),
    ]);
    const [pending] = await f.db
      .select({ notifiedChannels: approvals.notifiedChannels })
      .from(approvals)
      .where(eq(approvals.id, row.id));
    expect(pending?.notifiedChannels).toEqual(['owner', 'conversation', 'custom']);

    await f.db.update(approvals).set({ status: 'approved' }).where(eq(approvals.id, row.id));
    await f.repository.markNotified([row.id], ['owner', 'conversation']);
    const [terminal] = await f.db
      .select({ notifiedChannels: approvals.notifiedChannels })
      .from(approvals)
      .where(eq(approvals.id, row.id));
    expect(terminal?.notifiedChannels).toEqual(['owner', 'conversation', 'custom']);

    await f.repository.markNotified([], ['owner']);
    await f.repository.markNotified([row.id], []);
  } finally {
    await f.dispose();
  }
});

it('validates bounded notice queries', async () => {
  const f = await fixture();
  try {
    await expect(f.repository.listStalledNotices({ batch: 201 })).rejects.toThrow('batch');
    await expect(f.repository.listStalledNotices({ batch: 0 })).rejects.toThrow('batch');
    await expect(f.repository.listStalledNotices({ olderThanMinutes: -1 })).rejects.toThrow('age');
    await expect(f.repository.listStalledNotices({ now: new Date(Number.NaN) })).rejects.toThrow(
      'time',
    );
  } finally {
    await f.dispose();
  }
});
