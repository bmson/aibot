import { type Db, type TaskRow, tasks } from '@assistant/db';
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { InboundEvent } from '../events.js';
import { type TaskState, TaskStateSchema } from '../events.js';
import { getQueueNotifier } from '../queue.js';

export type TaskType = TaskRow['type'];

const CLAIMABLE = ['pending', 'waiting_event', 'sleeping'] as const;
const LEASE_MINUTES = 10;
const MAX_ATTEMPTS = 8;

/**
 * Create a workflow from a normalized event. Idempotent on externalEventId —
 * re-delivered events (Pub/Sub, Cloud Tasks are at-least-once) return the
 * existing task instead of creating a duplicate.
 */
export async function enqueueTask(
  db: Db,
  input: {
    event: InboundEvent;
    type: TaskType;
    budgetUsdLimit?: string;
    goalId?: string;
    parentTaskId?: string;
    runAfter?: Date;
    deadline?: Date;
    maxSteps?: number;
  },
): Promise<{ task: TaskRow; created: boolean }> {
  const values = {
    agentId: input.event.agentId,
    conversationId: input.event.conversationId,
    type: input.type,
    status: input.runAfter ? ('sleeping' as const) : ('pending' as const),
    trust: input.event.trust,
    trigger: input.event as unknown as Record<string, unknown>,
    externalEventId: input.event.externalEventId,
    goalId: input.goalId,
    parentTaskId: input.parentTaskId,
    runAfter: input.runAfter,
    deadline: input.deadline,
    ...(input.budgetUsdLimit ? { budgetUsdLimit: input.budgetUsdLimit } : {}),
    ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
  };

  if (input.event.externalEventId) {
    const [task] = await db
      .insert(tasks)
      .values(values)
      .onConflictDoNothing({
        target: tasks.externalEventId,
        // partial unique index — match its predicate
        where: sql`${tasks.externalEventId} IS NOT NULL`,
      })
      .returning();
    if (task) return { task, created: true };
    const [existing] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.externalEventId, input.event.externalEventId));
    if (!existing) throw new Error('enqueueTask: conflict but no existing task');
    return { task: existing, created: false };
  }

  const [task] = await db.insert(tasks).values(values).returning();
  if (!task) throw new Error('enqueueTask: insert failed');
  if (task.status === 'pending') getQueueNotifier().notify(task.id);
  return { task, created: true };
}

/**
 * Optimistic-lock claim. At-least-once delivery means concurrent executors
 * may race — exactly one wins; the rest get null and must treat it as done.
 */
export async function claimTask(db: Db, taskId: string): Promise<TaskRow | null> {
  const [claimed] = await db
    .update(tasks)
    .set({
      status: 'running',
      lockedUntil: sql`now() + interval '${sql.raw(String(LEASE_MINUTES))} minutes'`,
      attempt: sql`${tasks.attempt} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(tasks.id, taskId),
        or(...CLAIMABLE.map((s) => eq(tasks.status, s))),
        or(isNull(tasks.lockedUntil), lte(tasks.lockedUntil, sql`now()`)),
        or(isNull(tasks.runAfter), lte(tasks.runAfter, sql`now()`)),
      ),
    )
    .returning();
  return claimed ?? null;
}

/** Parse the checkpoint out of a task row (defaults for a fresh task). */
export function taskState(task: TaskRow): TaskState {
  return TaskStateSchema.parse(task.state ?? {});
}

/** Persist the checkpoint. Called once per step, in the same transaction as tool_calls updates. */
export async function checkpointTask(
  db: Db,
  taskId: string,
  state: TaskState,
  extra: Partial<{
    progress: string;
    progressPercent: number | null;
    nextAction: string;
  }> = {},
): Promise<void> {
  await db
    .update(tasks)
    .set({ state, ...extra, updatedAt: sql`now()` })
    .where(eq(tasks.id, taskId));
}

/** Park for approval — the queue task ends; resume is a fresh enqueue on resolution. */
export async function parkForApproval(
  db: Db,
  taskId: string,
  state: TaskState,
  pending: TaskState['pendingApprovals'],
): Promise<void> {
  await db
    .update(tasks)
    .set({
      status: 'waiting_approval',
      state: { ...state, pendingApprovals: pending },
      lockedUntil: null,
      updatedAt: sql`now()`,
    })
    .where(eq(tasks.id, taskId));
}

/** Sleep until runAfter (mission wake cadence, retries with backoff, timed waits). */
export async function sleepTask(
  db: Db,
  taskId: string,
  state: TaskState,
  runAfter: Date,
): Promise<void> {
  await db
    .update(tasks)
    .set({ status: 'sleeping', state, runAfter, lockedUntil: null, updatedAt: sql`now()` })
    .where(eq(tasks.id, taskId));
}

export async function completeTask(
  db: Db,
  taskId: string,
  outcome: { status: 'done' | 'failed' | 'cancelled'; progress?: string },
): Promise<void> {
  await db
    .update(tasks)
    .set({
      status: outcome.status,
      progress: outcome.progress ?? sql`${tasks.progress}`,
      lockedUntil: null,
      updatedAt: sql`now()`,
    })
    .where(eq(tasks.id, taskId));
}

/**
 * Mark a crashed/failed attempt. Below MAX_ATTEMPTS the task goes back to
 * pending (the queue retries); at the cap it dead-letters to needs_attention.
 */
export async function recordFailedAttempt(
  db: Db,
  task: TaskRow,
  error: string,
): Promise<'retry' | 'dead_letter'> {
  const deadLetter = task.attempt >= MAX_ATTEMPTS;
  await db
    .update(tasks)
    .set({
      status: deadLetter ? 'needs_attention' : 'pending',
      progress: `attempt ${task.attempt} failed: ${error.slice(0, 500)}`,
      lockedUntil: null,
      updatedAt: sql`now()`,
    })
    .where(eq(tasks.id, task.id));
  return deadLetter ? 'dead_letter' : 'retry';
}

/** Resume a parked task after approval resolution: back to pending for the queue. */
export async function wakeTask(db: Db, taskId: string): Promise<void> {
  await db
    .update(tasks)
    .set({ status: 'pending', runAfter: null, lockedUntil: null, updatedAt: sql`now()` })
    .where(eq(tasks.id, taskId));
  getQueueNotifier().notify(taskId);
}

/** Due work for the local poller / sweeper: pending now, or sleeping past runAfter, or dead leases. */
export async function findDueTasks(db: Db, limit = 10): Promise<TaskRow[]> {
  return db
    .select()
    .from(tasks)
    .where(
      and(
        or(
          eq(tasks.status, 'pending'),
          and(eq(tasks.status, 'sleeping'), lte(tasks.runAfter, sql`now()`)),
          and(eq(tasks.status, 'running'), lte(tasks.lockedUntil, sql`now()`)),
        ),
        or(isNull(tasks.runAfter), lte(tasks.runAfter, sql`now()`)),
      ),
    )
    .orderBy(tasks.updatedAt)
    .limit(limit);
}
