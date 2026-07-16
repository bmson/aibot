import { createDb, type Db, tasks } from '@assistant/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import type { InboundEvent } from '../events.js';
import {
  checkpointTask,
  claimTask,
  completeTask,
  enqueueTask,
  findDueTasks,
  parkForApproval,
  recordFailedAttempt,
  sleepTask,
  taskState,
  wakeTask,
} from './machine.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;
const createdTaskIds: string[] = [];

function event(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    source: 'internal',
    agentId,
    trust: 'assistant',
    payload: {},
    ...overrides,
  };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('machine.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp && createdTaskIds.length) {
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

async function track<T extends { task: { id: string } }>(p: Promise<T>): Promise<T> {
  const result = await p;
  createdTaskIds.push(result.task.id);
  return result;
}

describe('task state machine (integration)', () => {
  it('enqueues idempotently on externalEventId', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const ev = event({ externalEventId: `test-evt-${Date.now()}` });
    const first = await track(enqueueTask(db, { event: ev, type: 'adhoc' }));
    const second = await enqueueTask(db, { event: ev, type: 'adhoc' });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
  });

  it('claim wins exactly once between racers', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { task } = await track(enqueueTask(db, { event: event(), type: 'adhoc' }));
    const [a, b] = await Promise.all([claimTask(db, task.id), claimTask(db, task.id)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const winner = a ?? b;
    expect(winner?.status).toBe('running');
    expect(winner?.attempt).toBe(1);
  });

  it('checkpoint round-trips state; park + wake resumes from it', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { task } = await track(enqueueTask(db, { event: event(), type: 'adhoc' }));
    const claimed = await claimTask(db, task.id);
    expect(claimed).not.toBeNull();

    const state = taskState(claimed as NonNullable<typeof claimed>);
    state.phase = 'step-3';
    state.scratchpad = 'found two options';
    state.completedToolCallIds.push('tc-1');
    await checkpointTask(db, task.id, state, { progress: 'comparing options' });

    const pending = [
      {
        approvalId: '00000000-0000-0000-0000-000000000001',
        toolCallId: 'call_abc',
        dbToolCallId: '00000000-0000-0000-0000-000000000002',
        toolName: 'gmail.send',
      },
    ];
    await parkForApproval(db, task.id, state, pending);
    let [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('waiting_approval');

    // waiting_approval is NOT claimable — the queue can't steal a parked task
    expect(await claimTask(db, task.id)).toBeNull();

    await wakeTask(db, task.id);
    const reclaimed = await claimTask(db, task.id);
    expect(reclaimed).not.toBeNull();
    const resumed = taskState(reclaimed as NonNullable<typeof reclaimed>);
    expect(resumed.phase).toBe('step-3');
    expect(resumed.scratchpad).toBe('found two options');
    expect(resumed.completedToolCallIds).toContain('tc-1');
    expect(resumed.pendingApprovals).toEqual(pending);

    await completeTask(db, task.id, { status: 'done' });
    [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('done');
  });

  it('sleeping tasks are not due until runAfter, then wake via findDueTasks', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { task } = await track(enqueueTask(db, { event: event(), type: 'adhoc' }));
    const claimed = await claimTask(db, task.id);
    const future = new Date(Date.now() + 60_000);
    await sleepTask(db, task.id, taskState(claimed as NonNullable<typeof claimed>), future);

    const dueNow = await findDueTasks(db, 100);
    expect(dueNow.map((t) => t.id)).not.toContain(task.id);

    const past = new Date(Date.now() - 1000);
    await db.update(tasks).set({ runAfter: past }).where(eq(tasks.id, task.id));
    const dueLater = await findDueTasks(db, 100);
    expect(dueLater.map((t) => t.id)).toContain(task.id);
  });

  it('dead-letters after max attempts', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { task } = await track(enqueueTask(db, { event: event(), type: 'adhoc' }));
    await db.update(tasks).set({ attempt: 8 }).where(eq(tasks.id, task.id));
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    const outcome = await recordFailedAttempt(db, row as NonNullable<typeof row>, 'boom');
    expect(outcome).toBe('dead_letter');
    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after?.status).toBe('needs_attention');
  });

  it('retries below max attempts', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { task } = await track(enqueueTask(db, { event: event(), type: 'adhoc' }));
    const claimed = await claimTask(db, task.id);
    const outcome = await recordFailedAttempt(
      db,
      claimed as NonNullable<typeof claimed>,
      'transient',
    );
    expect(outcome).toBe('retry');
    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after?.status).toBe('pending');
  });
});
