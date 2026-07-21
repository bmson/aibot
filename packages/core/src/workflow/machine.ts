import { type Db, type TaskRow, tasks } from '@assistant/db';
import { and, eq, gt, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import type { InboundEvent, Plan } from '../events.js';
import { type TaskState, TaskStateSchema } from '../events.js';
import { getQueueNotifier } from '../queue.js';

export type TaskType = TaskRow['type'];

const CLAIMABLE = ['pending', 'sleeping', 'waiting_budget'] as const;
const WAKEABLE = [
  'waiting_approval',
  'waiting_event',
  'sleeping',
  'waiting_budget',
  'needs_attention',
] as const;
const TERMINAL = ['done', 'failed', 'cancelled'] as const;
const LEASE_MINUTES = 10;
const MAX_ATTEMPTS = 8;
// A worker that hangs or is killed (rather than throwing) never records a
// failed attempt, so it can't reach MAX_ATTEMPTS. Its lease simply expires and
// the task is reclaimed. Bound that separately: a task reclaimed this many
// times without ever checkpointing progress is a poison pill and dead-letters.
const MAX_RECLAIMS = 8;

function newLeaseExpiry() {
  // Truncate in PostgreSQL before decoding to JS Date. Raw now() can contain
  // microseconds that Date loses, making a later equality fence fail. Keeping
  // the clock database-side also avoids cross-container clock skew.
  return sql`date_trunc('milliseconds', clock_timestamp()) + interval '${sql.raw(String(LEASE_MINUTES))} minutes'`;
}

/**
 * A claimed row is also its lease: lockedUntil is a monotonically replaced
 * fencing token. Every executor-owned mutation compares it with the value
 * returned by claim/renew, so a reclaimed task makes the old worker harmless.
 */
export type TaskLease = TaskRow & { lockedUntil: Date };

function hasLease(task: TaskRow): task is TaskLease {
  return task.status === 'running' && task.lockedUntil instanceof Date;
}

function activeLease(task: TaskLease) {
  return and(
    eq(tasks.id, task.id),
    eq(tasks.status, 'running'),
    eq(tasks.lockedUntil, task.lockedUntil),
    gt(tasks.lockedUntil, sql`now()`),
  );
}

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
    /**
     * Pre-set the task's plan so the executor skips planning entirely. Used by
     * deterministically-enqueued internal children (e.g. the D9 known-sender
     * reply) whose next action is fixed rather than model-decided.
     */
    plan?: Plan;
    /** Caller is inside a larger transaction and will notify only after commit. */
    deferNotification?: boolean;
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
    ...(input.plan ? { plan: input.plan } : {}),
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
    if (task) {
      if (task.status === 'pending' && !input.deferNotification) {
        getQueueNotifier().notify(task.id, task.queueGeneration);
      }
      return { task, created: true };
    }
    const [existing] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.externalEventId, input.event.externalEventId));
    if (!existing) throw new Error('enqueueTask: conflict but no existing task');
    return { task: existing, created: false };
  }

  const [task] = await db.insert(tasks).values(values).returning();
  if (!task) throw new Error('enqueueTask: insert failed');
  if (task.status === 'pending' && !input.deferNotification) {
    getQueueNotifier().notify(task.id, task.queueGeneration);
  }
  return { task, created: true };
}

/**
 * Optimistic-lock claim. At-least-once delivery means concurrent executors
 * may race — exactly one wins; the rest get null and must treat it as done.
 */
export async function claimTask(db: Db, taskId: string): Promise<TaskLease | null> {
  const lockedUntil = newLeaseExpiry();
  const [claimed] = await db
    .update(tasks)
    .set({
      status: 'running',
      lockedUntil,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(tasks.id, taskId),
        or(
          and(
            or(...CLAIMABLE.map((s) => eq(tasks.status, s))),
            or(isNull(tasks.lockedUntil), lte(tasks.lockedUntil, sql`now()`)),
          ),
          // A crashed worker's expired running lease is atomically reclaimed.
          and(
            eq(tasks.status, 'running'),
            or(isNull(tasks.lockedUntil), lte(tasks.lockedUntil, sql`now()`)),
          ),
        ),
        or(isNull(tasks.runAfter), lte(tasks.runAfter, sql`now()`)),
      ),
    )
    .returning();
  if (!claimed || !hasLease(claimed)) return null;
  return claimed;
}

/**
 * Extend a live lease before another potentially expensive/side-effecting
 * step. Mutates the local row's fencing token so subsequent CAS writes use
 * the renewed value. A false result means cancellation or another worker won.
 */
export async function renewTaskLease(db: Db, task: TaskLease): Promise<boolean> {
  const lockedUntil = newLeaseExpiry();
  const [renewed] = await db
    .update(tasks)
    .set({
      lockedUntil,
      updatedAt: sql`now()`,
    })
    .where(activeLease(task))
    .returning({ lockedUntil: tasks.lockedUntil });
  if (!renewed?.lockedUntil) return false;
  task.lockedUntil = renewed.lockedUntil;
  return true;
}

/** Parse the checkpoint out of a task row (defaults for a fresh task). */
export function taskState(task: TaskRow): TaskState {
  return TaskStateSchema.parse(task.state ?? {});
}

/** Persist the checkpoint. Called once per step, in the same transaction as tool_calls updates. */
export async function checkpointTask(
  db: Db,
  task: TaskLease,
  state: TaskState,
  extra: Partial<{
    progress: string;
    progressPercent: number | null;
    nextAction: string;
    lastReflectedAt: Date;
  }> = {},
): Promise<boolean> {
  const [updated] = await db
    .update(tasks)
    // A checkpoint is proof of forward progress, so clear both failure counters:
    // the retry attempt count AND the lease-reclaim count (this task is not a
    // poison pill — it advanced past a step boundary).
    .set({ state, ...extra, attempt: 0, reclaimCount: 0, updatedAt: sql`now()` })
    .where(activeLease(task))
    .returning({ id: tasks.id });
  return Boolean(updated);
}

/** Park for approval — the queue task ends; resume is a fresh enqueue on resolution. */
export async function parkForApproval(
  db: Db,
  task: TaskLease,
  state: TaskState,
  pending: TaskState['pendingApprovals'],
): Promise<boolean> {
  const [updated] = await db
    .update(tasks)
    .set({
      status: 'waiting_approval',
      state: { ...state, pendingApprovals: pending },
      runAfter: null,
      lockedUntil: null,
      attempt: 0,
      updatedAt: sql`now()`,
    })
    .where(activeLease(task))
    .returning({ id: tasks.id });
  return Boolean(updated);
}

/**
 * Park because a budget ceiling is exhausted (Phase 27): checkpointed like a
 * sleep, but the distinct status makes "waiting on money, not on time or a
 * human" visible on the dashboard. runAfter = the period reset, so parked
 * work auto-resumes when the cap does.
 */
export async function parkForBudget(
  db: Db,
  task: TaskLease,
  state: TaskState,
  resumeAt: Date,
): Promise<boolean> {
  const [updated] = await db
    .update(tasks)
    .set({
      status: 'waiting_budget',
      state,
      runAfter: resumeAt,
      lockedUntil: null,
      queueGeneration: sql`${tasks.queueGeneration} + 1`,
      attempt: 0,
      updatedAt: sql`now()`,
    })
    .where(activeLease(task))
    .returning({ id: tasks.id });
  return Boolean(updated);
}

/** Sleep until runAfter (mission wake cadence, retries with backoff, timed waits). */
export async function sleepTask(
  db: Db,
  task: TaskLease,
  state: TaskState,
  runAfter: Date,
): Promise<boolean> {
  const [updated] = await db
    .update(tasks)
    .set({
      status: 'sleeping',
      state,
      runAfter,
      lockedUntil: null,
      queueGeneration: sql`${tasks.queueGeneration} + 1`,
      attempt: 0,
      // A deliberate yield to sleep (code-job checkpoint, mission wake, browser-job
      // wait) is proof of forward progress, so clear the poison-pill reclaim
      // counter too. A genuinely hung worker never reaches here — its running
      // lease simply expires and findDueTasks reclaims it. Without this, a
      // long-running import/mission that survives a few mid-run worker deaths
      // accrues reclaimCount and falsely dead-letters as a poison pill.
      reclaimCount: 0,
      updatedAt: sql`now()`,
    })
    .where(activeLease(task))
    .returning({ id: tasks.id });
  return Boolean(updated);
}

export function completeTask(
  db: Db,
  task: TaskLease,
  outcome: { status: 'done' | 'failed' | 'cancelled'; progress?: string },
): Promise<boolean>;
/** Administrative cancellation does not need an executor lease. */
export function completeTask(
  db: Db,
  taskId: string,
  outcome: { status: 'cancelled'; progress?: string },
): Promise<boolean>;
export async function completeTask(
  db: Db,
  taskOrId: TaskLease | string,
  outcome: { status: 'done' | 'failed' | 'cancelled'; progress?: string },
): Promise<boolean> {
  const where =
    typeof taskOrId === 'string'
      ? and(eq(tasks.id, taskOrId), notInArray(tasks.status, [...TERMINAL]))
      : activeLease(taskOrId);
  const [updated] = await db
    .update(tasks)
    .set({
      status: outcome.status,
      progress: outcome.progress ?? sql`${tasks.progress}`,
      lockedUntil: null,
      runAfter: null,
      attempt: 0,
      updatedAt: sql`now()`,
    })
    .where(where)
    .returning({ id: tasks.id });
  return Boolean(updated);
}

/** Executor-owned transition for a task that needs operator intervention. */
export async function markTaskNeedsAttention(
  db: Db,
  task: TaskLease,
  progress: string,
): Promise<boolean> {
  const [updated] = await db
    .update(tasks)
    .set({
      status: 'needs_attention',
      progress: progress.slice(0, 500),
      lockedUntil: null,
      runAfter: null,
      attempt: 0,
      updatedAt: sql`now()`,
    })
    .where(activeLease(task))
    .returning({ id: tasks.id });
  return Boolean(updated);
}

/** Executor-owned mission pause. */
export async function parkForEvent(db: Db, task: TaskLease): Promise<boolean> {
  const [updated] = await db
    .update(tasks)
    .set({
      status: 'waiting_event',
      lockedUntil: null,
      runAfter: null,
      attempt: 0,
      updatedAt: sql`now()`,
    })
    .where(activeLease(task))
    .returning({ id: tasks.id });
  return Boolean(updated);
}

/**
 * Mark a crashed/failed attempt. Below MAX_ATTEMPTS the task sleeps with
 * bounded exponential backoff; at the cap it dead-letters to needs_attention.
 */
export async function recordFailedAttempt(
  db: Db,
  task: TaskLease,
  error: string,
): Promise<'retry' | 'dead_letter' | 'lost_lease'> {
  const message = error.slice(0, 500);
  const [updated] = await db
    .update(tasks)
    .set({
      attempt: sql`${tasks.attempt} + 1`,
      status: sql`CASE WHEN ${tasks.attempt} + 1 >= ${MAX_ATTEMPTS} THEN 'needs_attention' ELSE 'sleeping' END`,
      progress: sql`'attempt ' || (${tasks.attempt} + 1)::text || ' failed: ' || ${message}`,
      runAfter: sql`CASE WHEN ${tasks.attempt} + 1 >= ${MAX_ATTEMPTS} THEN NULL ELSE now() + least(300, (5 * power(2, ${tasks.attempt}))::int) * interval '1 second' END`,
      lockedUntil: null,
      queueGeneration: sql`${tasks.queueGeneration} + 1`,
      updatedAt: sql`now()`,
    })
    .where(activeLease(task))
    .returning({ status: tasks.status, queueGeneration: tasks.queueGeneration });
  if (!updated) return 'lost_lease';
  return updated.status === 'needs_attention' ? 'dead_letter' : 'retry';
}

/** Resume a parked task after approval resolution: back to pending for the queue. */
export async function wakeTask(db: Db, taskId: string): Promise<boolean> {
  const [woken] = await db
    .update(tasks)
    .set({
      status: 'pending',
      runAfter: null,
      lockedUntil: null,
      queueGeneration: sql`${tasks.queueGeneration} + 1`,
      attempt: 0,
      updatedAt: sql`now()`,
    })
    .where(and(eq(tasks.id, taskId), inArray(tasks.status, [...WAKEABLE])))
    .returning({ id: tasks.id, queueGeneration: tasks.queueGeneration });
  if (!woken) return false;
  getQueueNotifier().notify(taskId, woken.queueGeneration);
  return true;
}

/** Due work for the local poller / sweeper: pending now, or sleeping past runAfter, or dead leases. */
export async function findDueTasks(db: Db, limit = 10): Promise<TaskRow[]> {
  // A Cloud Tasks delivery normally retries itself if its worker disappears.
  // If the delivery is exhausted or the process dies after acknowledgement,
  // turn the expired lease into a new runnable generation exactly once. The
  // status guard makes concurrent sweepers converge on the same transition.
  const expiredRunning = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, 'running'),
        or(isNull(tasks.lockedUntil), lte(tasks.lockedUntil, sql`now()`)),
      ),
    )
    .orderBy(tasks.lockedUntil)
    .limit(limit);
  await db
    .update(tasks)
    .set({
      // Count the reclaim, and dead-letter to needs_attention once a task has
      // been reclaimed MAX_RECLAIMS times without ever checkpointing progress
      // (a deterministically hanging/crashing step) instead of resurrecting it
      // to churn a worker forever with no owner-visible terminal state.
      status: sql`CASE WHEN ${tasks.reclaimCount} + 1 >= ${MAX_RECLAIMS} THEN 'needs_attention' ELSE 'pending' END`,
      reclaimCount: sql`${tasks.reclaimCount} + 1`,
      progress: sql`CASE WHEN ${tasks.reclaimCount} + 1 >= ${MAX_RECLAIMS} THEN 'stopped after a worker repeatedly failed to complete a step without recording progress (hung or killed ' || (${tasks.reclaimCount} + 1)::text || ' times)' ELSE ${tasks.progress} END`,
      runAfter: sql`CASE WHEN ${tasks.reclaimCount} + 1 >= ${MAX_RECLAIMS} THEN NULL ELSE ${tasks.runAfter} END`,
      lockedUntil: null,
      queueGeneration: sql`${tasks.queueGeneration} + 1`,
    })
    .where(and(eq(tasks.status, 'running'), inArray(tasks.id, expiredRunning)));

  return db
    .select()
    .from(tasks)
    .where(
      and(
        or(
          eq(tasks.status, 'pending'),
          and(eq(tasks.status, 'sleeping'), lte(tasks.runAfter, sql`now()`)),
          and(eq(tasks.status, 'waiting_budget'), lte(tasks.runAfter, sql`now()`)),
        ),
        or(isNull(tasks.runAfter), lte(tasks.runAfter, sql`now()`)),
      ),
    )
    .orderBy(tasks.updatedAt)
    .limit(limit);
}
