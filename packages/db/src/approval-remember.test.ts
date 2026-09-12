import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPostgresApprovalRepository,
  getRememberableApproval,
  resolveApproval,
} from './approval-repository.js';
import { createDb, type Db } from './client.js';
import { agents, approvals, tasks, toolCalls } from './schema.js';

const DATABASE_URL = process.env.DATABASE_URL;

function testDatabaseUrl(): string {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
}

describe('PostgreSQL approval remember flow', () => {
  let db: Db | undefined;
  let secondaryAgentId: string | undefined;
  const taskIds: string[] = [];
  const toolCallIds: string[] = [];
  const approvalIds: string[] = [];

  afterEach(async () => {
    if (!db) return;
    if (toolCallIds.length)
      await db
        .update(toolCalls)
        .set({ approvalId: null })
        .where(inArray(toolCalls.id, toolCallIds));
    if (approvalIds.length) await db.delete(approvals).where(inArray(approvals.id, approvalIds));
    if (toolCallIds.length) await db.delete(toolCalls).where(inArray(toolCalls.id, toolCallIds));
    if (taskIds.length) await db.delete(tasks).where(inArray(tasks.id, taskIds));
    if (secondaryAgentId) await db.delete(agents).where(eq(agents.id, secondaryAgentId));
    await db.$client.end();
    db = undefined;
    secondaryAgentId = undefined;
    taskIds.length = 0;
    toolCallIds.length = 0;
    approvalIds.length = 0;
  });

  it('scopes rememberable reads and rejects a mismatched policy atomically', async () => {
    db = createDb(testDatabaseUrl());
    const [owner] = await db.select({ id: agents.id }).from(agents).limit(1);
    if (!owner) throw new Error('Seed the test database');
    const otherAgentId = randomUUID();
    secondaryAgentId = otherAgentId;
    await db.insert(agents).values({
      id: otherAgentId,
      name: `remember-test-${otherAgentId.slice(0, 8)}`,
      email: `${otherAgentId}@remember-test.invalid`,
      workspacePrefix: `remember-test/${otherAgentId}`,
    });

    const taskId = randomUUID();
    const toolCallId = randomUUID();
    const approvalId = randomUUID();
    taskIds.push(taskId);
    toolCallIds.push(toolCallId);
    approvalIds.push(approvalId);

    await db.insert(tasks).values({
      id: taskId,
      agentId: owner.id,
      type: 'chat_turn',
      trust: 'owner',
      status: 'waiting_approval',
    });
    await db.insert(toolCalls).values({
      id: toolCallId,
      taskId,
      step: 0,
      toolName: 'gmail.send',
      risk: 'approval',
      status: 'awaiting_approval',
      decision: { riskTier: 'high' },
    });
    await db.insert(approvals).values({
      id: approvalId,
      taskId,
      toolCallId,
      shortCode: `A${approvalId.slice(0, 8)}`,
      summary: 'send email',
      payload: { to: ['friend@example.com'] },
      resolutionPayload: null,
      status: 'pending',
      requestedAt: new Date('2026-09-12T12:00:00.000Z'),
      resolvedAt: null,
      resolvedVia: null,
      expiresAt: new Date('2026-09-13T12:00:00.000Z'),
    });
    await db.update(toolCalls).set({ approvalId }).where(eq(toolCalls.id, toolCallId));

    const repository = createPostgresApprovalRepository(db);
    await expect(getRememberableApproval(db, owner.id, approvalId)).resolves.toMatchObject({
      approval: { id: approvalId, status: 'pending' },
      toolName: 'gmail.send',
    });
    await expect(repository.getRememberable(otherAgentId, approvalId)).resolves.toBeNull();

    const mismatchedTaskId = randomUUID();
    taskIds.push(mismatchedTaskId);
    await db.insert(tasks).values({
      id: mismatchedTaskId,
      agentId: owner.id,
      type: 'chat_turn',
      trust: 'owner',
      status: 'waiting_approval',
    });
    await db
      .update(toolCalls)
      .set({ taskId: mismatchedTaskId })
      .where(eq(toolCalls.id, toolCallId));
    await expect(repository.getRememberable(owner.id, approvalId)).resolves.toBeNull();
    await db.update(toolCalls).set({ taskId }).where(eq(toolCalls.id, toolCallId));

    await expect(
      resolveApproval(db, {
        approvalId,
        decision: 'approved',
        via: 'web',
        policy: {
          agentId: otherAgentId,
          toolName: 'gmail.send',
          templateKey: 'gmail.send.to_recipient',
          match: { recipient: 'friend@example.com' },
          effect: 'allow',
        },
      }),
    ).rejects.toThrow('task owner and tool');
    const [stillPending] = await db
      .select({ status: approvals.status })
      .from(approvals)
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, 'pending')));
    expect(stillPending?.status).toBe('pending');
  });
});
