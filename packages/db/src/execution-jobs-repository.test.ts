import { randomUUID } from 'node:crypto';
import type { TaskLease } from '@assistant/persistence';
import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresExecutionJobRepository } from './execution-jobs-repository.js';
import { agents, approvals, tasks, toolCalls } from './schema.js';

const DATABASE_URL = process.env.DATABASE_URL;
const testUrl = () => {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
};
const HASH = 'a'.repeat(64);
const EXPIRED_TOKEN = '00000000-0000-4000-8000-000000000001';
const REPLACEMENT_TOKEN = '00000000-0000-4000-8000-000000000002';
const LIVE_TOKEN = '00000000-0000-4000-8000-000000000003';
const SENTINEL = {
  pending: 'document_job_pending',
  callbackToken: HASH,
  timeoutAt: '2026-09-12T12:05:00.000Z',
  executionName: 'documents/task/job',
};

describe('PostgreSQL execution job repository', () => {
  let db: Db;
  let agentId: string;
  const taskIds: string[] = [];
  const toolIds: string[] = [];
  const approvalIds: string[] = [];

  beforeEach(async () => {
    db = createDb(testUrl());
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      name: `execution-job-${agentId.slice(0, 8)}`,
      email: `${agentId}@execution-job.invalid`,
      workspacePrefix: `execution-job/${agentId}`,
    });
  });

  afterEach(async () => {
    if (toolIds.length)
      await db.update(toolCalls).set({ approvalId: null }).where(inArray(toolCalls.id, toolIds));
    if (approvalIds.length) await db.delete(approvals).where(inArray(approvals.id, approvalIds));
    if (toolIds.length) await db.delete(toolCalls).where(inArray(toolCalls.id, toolIds));
    if (taskIds.length) await db.delete(tasks).where(inArray(tasks.id, taskIds));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.$client.end();
    taskIds.length = 0;
    toolIds.length = 0;
    approvalIds.length = 0;
  });

  async function seedTask(
    input: {
      leaseToken?: string | null;
      lockedUntil?: Date;
      result?: unknown;
      startedAt?: Date;
      decision?: unknown;
    } = {},
  ) {
    const taskId = randomUUID();
    const toolCallId = randomUUID();
    taskIds.push(taskId);
    toolIds.push(toolCallId);
    await db.insert(tasks).values({
      id: taskId,
      agentId,
      type: 'chat_turn',
      trust: 'owner',
      status: 'running',
      state: { before: true },
      attempt: 3,
      reclaimCount: 2,
      leaseToken: input.leaseToken ?? null,
      lockedUntil: input.lockedUntil ?? new Date(Date.now() + 300_000),
    });
    await db.insert(toolCalls).values({
      id: toolCallId,
      taskId,
      step: 1,
      toolName: 'document.process',
      risk: 'autonomous',
      status: 'executing',
      args: {},
      result: input.result ?? null,
      startedAt: input.startedAt,
      decision: input.decision ?? {},
    });
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    if (!row?.lockedUntil) throw new Error('task lease was not seeded');
    return { taskId, toolCallId, lease: row as TaskLease };
  }

  it('atomically stages and clears the full sentinel and checkpoint under a legacy null-token lease', async () => {
    const { taskId, toolCallId, lease } = await seedTask();
    const repository = createPostgresExecutionJobRepository(db);

    await repository.stage(
      { taskId, toolCallId, pending: SENTINEL, checkpointState: { pendingJob: 'staged' } },
      lease,
    );
    let [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    let [tool] = await db.select().from(toolCalls).where(eq(toolCalls.id, toolCallId));
    expect(tool?.result).toEqual(SENTINEL);
    expect(task).toMatchObject({ state: { pendingJob: 'staged' }, attempt: 0, reclaimCount: 0 });

    await repository.clear(
      { taskId, toolCallId, pending: SENTINEL, checkpointState: { pendingJob: null } },
      lease,
    );
    [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    [tool] = await db.select().from(toolCalls).where(eq(toolCalls.id, toolCallId));
    expect(tool?.result).toBeNull();
    expect(task?.state).toEqual({ pendingJob: null });
  });

  it('fences expired and reclaimed leases without changing either record', async () => {
    const seeded = await seedTask({
      leaseToken: EXPIRED_TOKEN,
      lockedUntil: new Date(Date.now() - 60_000),
    });
    const repository = createPostgresExecutionJobRepository(db);
    const checkpointState = { shouldNotPersist: true };

    await expect(
      repository.stage({ ...seeded, pending: SENTINEL, checkpointState }, seeded.lease),
    ).rejects.toThrow('task lease lost');
    const replacementUntil = new Date(Date.now() + 300_000);
    await db
      .update(tasks)
      .set({ leaseToken: REPLACEMENT_TOKEN, lockedUntil: replacementUntil })
      .where(eq(tasks.id, seeded.taskId));
    await expect(
      repository.stage(
        {
          taskId: seeded.taskId,
          toolCallId: seeded.toolCallId,
          pending: SENTINEL,
          checkpointState,
        },
        seeded.lease,
      ),
    ).rejects.toThrow('task lease lost');

    const [freshRow] = await db.select().from(tasks).where(eq(tasks.id, seeded.taskId));
    if (!freshRow?.lockedUntil) throw new Error('replacement lease missing');
    await repository.stage(
      {
        taskId: seeded.taskId,
        toolCallId: seeded.toolCallId,
        pending: SENTINEL,
        checkpointState: { reclaimed: true },
      },
      freshRow as TaskLease,
    );
    await db.update(tasks).set({ leaseToken: randomUUID() }).where(eq(tasks.id, seeded.taskId));
    await expect(
      repository.settle(
        { taskId: seeded.taskId, toolCallId: seeded.toolCallId, timeoutAt: new Date(0) },
        freshRow as TaskLease,
      ),
    ).resolves.toEqual({ kind: 'stale' });
    await expect(
      repository.loadToolCall(agentId, seeded.taskId, seeded.toolCallId),
    ).resolves.toMatchObject({
      result: SENTINEL,
    });
  });

  it('keeps tool and approval reads scoped to both agent and task', async () => {
    const owned = await seedTask();
    const foreign = await seedTask();
    const approvalId = randomUUID();
    approvalIds.push(approvalId);
    await db.insert(approvals).values({
      id: approvalId,
      taskId: owned.taskId,
      toolCallId: owned.toolCallId,
      shortCode: `A${approvalId.slice(0, 8)}`,
      summary: 'execution job approval',
      payload: {},
      status: 'approved',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const repository = createPostgresExecutionJobRepository(db);
    await expect(
      repository.loadToolCall(
        '00000000-0000-0000-0000-000000000000',
        owned.taskId,
        owned.toolCallId,
      ),
    ).resolves.toBeNull();
    await expect(
      repository.loadToolCall(agentId, foreign.taskId, owned.toolCallId),
    ).resolves.toBeNull();
    await expect(
      repository.loadToolCall(agentId, owned.taskId, owned.toolCallId),
    ).resolves.toMatchObject({ id: owned.toolCallId });
    await expect(
      repository.stage(
        {
          taskId: owned.taskId,
          toolCallId: foreign.toolCallId,
          pending: SENTINEL,
          checkpointState: { foreignWrite: true },
        },
        owned.lease,
      ),
    ).rejects.toThrow('cannot be staged');
    await expect(
      repository.loadToolCall(agentId, foreign.taskId, foreign.toolCallId),
    ).resolves.toMatchObject({ result: null });
    await expect(
      repository.listPendingApprovals(agentId, owned.taskId, [approvalId]),
    ).resolves.toEqual([expect.objectContaining({ id: approvalId, status: 'approved' })]);
    await expect(
      repository.listPendingApprovals(agentId, foreign.taskId, [approvalId]),
    ).resolves.toEqual([]);
  });

  it('lets a callback result win a passed timeout and returns cost reconciliation metadata', async () => {
    const startedAt = new Date(Date.now() - 25_000);
    const decision = { reservationId: 'reservation-result', rateKey: 'cloud_run_job_sec' };
    const seeded = await seedTask({
      result: SENTINEL,
      startedAt,
      decision,
      leaseToken: LIVE_TOKEN,
    });
    await db
      .update(toolCalls)
      .set({ status: 'succeeded', result: { ok: true, output: 'callback result' } })
      .where(eq(toolCalls.id, seeded.toolCallId));

    const settled = await createPostgresExecutionJobRepository(db).settle(
      { taskId: seeded.taskId, toolCallId: seeded.toolCallId, timeoutAt: new Date(0) },
      seeded.lease,
    );
    expect(settled).toEqual({
      kind: 'result',
      id: seeded.toolCallId,
      result: { ok: true, output: 'callback result' },
      startedAt,
      decision,
    });
    const [tool] = await db.select().from(toolCalls).where(eq(toolCalls.id, seeded.toolCallId));
    expect(tool).toMatchObject({
      status: 'succeeded',
      result: { ok: true, output: 'callback result' },
    });
  });

  it('does not let clear or a repeated stage overwrite a callback result', async () => {
    const seeded = await seedTask({ result: SENTINEL, leaseToken: LIVE_TOKEN });
    const callbackResult = { ok: true, output: 'arrived before launch cleanup' };
    await db
      .update(toolCalls)
      .set({ result: callbackResult })
      .where(eq(toolCalls.id, seeded.toolCallId));
    const repository = createPostgresExecutionJobRepository(db);
    const input = {
      taskId: seeded.taskId,
      toolCallId: seeded.toolCallId,
      pending: SENTINEL,
      checkpointState: { mustNotPersist: true },
    };

    await expect(repository.clear(input, seeded.lease)).rejects.toThrow('cannot be cleared');
    await expect(repository.stage(input, seeded.lease)).rejects.toThrow('cannot be staged');
    const [tool] = await db.select().from(toolCalls).where(eq(toolCalls.id, seeded.toolCallId));
    const [task] = await db.select().from(tasks).where(eq(tasks.id, seeded.taskId));
    expect(tool?.result).toEqual(callbackResult);
    expect(task?.state).toEqual({ before: true });
  });

  it('times out a live sentinel using the database clock and returns reservation metadata', async () => {
    const startedAt = new Date(Date.now() - 61_000);
    const decision = { reservationId: 'reservation-timeout' };
    const seeded = await seedTask({
      result: SENTINEL,
      startedAt,
      decision,
      leaseToken: LIVE_TOKEN,
    });
    const repository = createPostgresExecutionJobRepository(db);
    // Dispatch records a successful launch as succeeded while retaining the
    // sentinel until the callback replaces it with the terminal result.
    await db
      .update(toolCalls)
      .set({ status: 'succeeded' })
      .where(eq(toolCalls.id, seeded.toolCallId));

    await expect(
      repository.settle(
        {
          taskId: seeded.taskId,
          toolCallId: seeded.toolCallId,
          timeoutAt: new Date(Date.now() + 60_000),
        },
        seeded.lease,
      ),
    ).resolves.toEqual({ kind: 'still_pending' });
    const settled = await repository.settle(
      { taskId: seeded.taskId, toolCallId: seeded.toolCallId, timeoutAt: new Date(0) },
      seeded.lease,
    );
    expect(settled).toMatchObject({
      kind: 'timeout',
      id: seeded.toolCallId,
      startedAt,
      decision,
      failure: { ok: false },
    });
    const [tool] = await db
      .select()
      .from(toolCalls)
      .where(and(eq(toolCalls.id, seeded.toolCallId), eq(toolCalls.taskId, seeded.taskId)));
    expect(tool).toMatchObject({ status: 'failed', error: expect.stringContaining('timed out') });
    expect(tool?.finishedAt).toBeInstanceOf(Date);
  });
});
