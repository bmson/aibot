import {
  approvals,
  conversations,
  createDb,
  type Db,
  messages,
  type TaskRow,
  tasks,
  toolCalls,
} from '@assistant/db';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import { markApprovalsNotified, renotifyStalledApprovals } from './approvals.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId = '';
const createdTaskIds: string[] = [];
const createdChatIds: string[] = [];

interface Fixture {
  taskId: string;
  approvalId: string;
  shortCode: string;
  conversationId: string;
}

/** A waiting_approval task with one pending, never-notified approval — the crash residue. */
async function insertSilentParkedApproval(minutesOld: number): Promise<Fixture> {
  const [chat] = await db
    .insert(conversations)
    .values({ agentId, channel: 'chat', trust: 'owner', title: 'renotify-test' })
    .returning();
  const conversationId = (chat as NonNullable<typeof chat>).id;
  createdChatIds.push(conversationId);
  const [task] = await db
    .insert(tasks)
    .values({
      agentId,
      conversationId,
      type: 'chat_turn',
      status: 'waiting_approval',
      trust: 'owner',
      trigger: { source: 'web', payload: {} },
    })
    .returning();
  const taskId = (task as NonNullable<typeof task>).id;
  createdTaskIds.push(taskId);
  const [toolCall] = await db
    .insert(toolCalls)
    .values({
      taskId,
      step: 0,
      toolName: 'gmail.send',
      args: { to: 'someone@example.com' },
      risk: 'approval',
      status: 'awaiting_approval',
    })
    .returning();
  const shortCode = `T${Math.floor(Math.random() * 1e6)}`;
  const [approval] = await db
    .insert(approvals)
    .values({
      taskId,
      toolCallId: (toolCall as NonNullable<typeof toolCall>).id,
      shortCode,
      summary: 'Send the reply to someone@example.com',
      payload: { to: 'someone@example.com' },
      requestedAt: new Date(Date.now() - minutesOld * 60e3),
      expiresAt: new Date(Date.now() + 86400e3),
    })
    .returning();
  return {
    taskId,
    approvalId: (approval as NonNullable<typeof approval>).id,
    shortCode,
    conversationId,
  };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('approvals.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    // messages reference tasks (task_id FK), so they must go first.
    if (createdChatIds.length) {
      await db.delete(messages).where(inArray(messages.conversationId, createdChatIds));
    }
    if (createdTaskIds.length) {
      await db.delete(approvals).where(inArray(approvals.taskId, createdTaskIds));
      await db.delete(toolCalls).where(inArray(toolCalls.taskId, createdTaskIds));
      await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
    }
    if (createdChatIds.length) {
      await db.delete(conversations).where(inArray(conversations.id, createdChatIds));
    }
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('renotifyStalledApprovals (integration)', () => {
  it('re-emits owner + conversation notices for a silently parked approval, exactly once', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture = await insertSilentParkedApproval(10);
    const notified: Array<{ taskId: string; shortCode: string }> = [];
    const notify = async (
      task: TaskRow,
      notices: Array<{ taskId: string; shortCode: string; summary: string }>,
    ) => {
      for (const notice of notices) notified.push({ taskId: task.id, shortCode: notice.shortCode });
    };

    const first = await renotifyStalledApprovals(db, notify);
    expect(first).toBeGreaterThanOrEqual(1);
    expect(notified).toContainEqual({ taskId: fixture.taskId, shortCode: fixture.shortCode });

    // The dashboard conversation got the standard approval notice with parts.
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, fixture.conversationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toContain(fixture.shortCode);
    expect(JSON.stringify(rows[0]?.parts)).toContain(fixture.approvalId);

    // Stamped — the next sweep must not spam the owner again.
    const [row] = await db.select().from(approvals).where(eq(approvals.id, fixture.approvalId));
    expect(row?.notifiedChannels).toEqual(['owner', 'conversation']);
    notified.length = 0;
    expect(await renotifyStalledApprovals(db, notify)).toBe(0);
    expect(notified).toHaveLength(0);
  });

  it('leaves fresh approvals alone (the executor is still inside its own notify window)', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture = await insertSilentParkedApproval(1);
    const count = await renotifyStalledApprovals(db, async () => {});
    const [row] = await db.select().from(approvals).where(eq(approvals.id, fixture.approvalId));
    expect(row?.notifiedChannels).toEqual([]);
    void count; // other fixtures may be due; this one must simply be untouched
  });

  it('a failing notifier leaves the approval unstamped for the next sweep', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture = await insertSilentParkedApproval(10);
    await renotifyStalledApprovals(db, async () => {
      throw new Error('SMS provider down');
    });
    const [row] = await db.select().from(approvals).where(eq(approvals.id, fixture.approvalId));
    expect(row?.notifiedChannels).toEqual([]);
    // No half-notice in the conversation either — the notify failure aborted the task's batch.
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, fixture.conversationId));
    expect(rows).toHaveLength(0);
  });

  it('markApprovalsNotified only stamps pending approvals', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture = await insertSilentParkedApproval(10);
    await db
      .update(approvals)
      .set({ status: 'denied' })
      .where(eq(approvals.id, fixture.approvalId));
    await markApprovalsNotified(db, [fixture.approvalId], ['owner']);
    const [row] = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, fixture.approvalId), eq(approvals.status, 'denied')));
    expect(row?.notifiedChannels).toEqual([]);
  });
});
