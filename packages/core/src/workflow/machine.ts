import {
  createPostgresTaskLeaseRepository,
  createPostgresTaskRepository,
  type Db,
  rateLimits,
  type TaskRow,
  tasks,
} from '@assistant/db';
import type {
  TaskCheckpoint,
  TaskLease,
  TaskLeaseRepository,
  TaskRepository,
} from '@assistant/persistence';
import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { InboundEvent, Plan } from '../events.js';
import { type TaskState, TaskStateSchema } from '../events.js';
import { getQueueNotifier } from '../queue.js';
import type { AutonomyGrant } from './autonomy.js';

function leases(store: Db | TaskLeaseRepository): TaskLeaseRepository {
  return 'kind' in store && store.kind === 'task-lease-repository'
    ? (store as TaskLeaseRepository)
    : createPostgresTaskLeaseRepository(store as Db);
}

function lifecycle(store: Db | TaskRepository): TaskRepository {
  return 'kind' in store && store.kind === 'task-lease-repository'
    ? (store as TaskRepository)
    : createPostgresTaskRepository(store as Db);
}

export type TaskType = TaskRow['type'];

/**
 * A short human title from the trigger, so activity/approval UIs show "Reply to
 * Anna about the venue" instead of the generic type bucket "Inbox request".
 * Deterministic (no model) and always present. Prefers the email subject, then
 * the message/instruction text; trimmed to a single line.
 */
export function deriveTaskTitle(event: InboundEvent): string | undefined {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  const raw =
    str(payload.subject) || str(payload.text) || str(payload.instruction) || str(payload.schedule);
  if (!raw) return undefined;
  return raw.length > 80 ? `${raw.slice(0, 79)}…` : raw;
}

/**
 * A claimed row is also its lease: lockedUntil enforces expiry and leaseToken
 * is an opaque fencing token. Every executor-owned mutation compares it with the value
 * returned by claim/renew, so a reclaimed task makes the old worker harmless.
 */
export type { TaskLease } from '@assistant/persistence';

/**
 * Create a workflow from a normalized event. Idempotent on externalEventId —
 * re-delivered events (Pub/Sub, Cloud Tasks are at-least-once) return the
 * existing task instead of creating a duplicate.
 */
/** Thrown when the externally-triggered task backstop is exhausted. */
export class TaskRateLimitError extends Error {
  constructor() {
    super('externally-triggered task rate limit exceeded');
    this.name = 'TaskRateLimitError';
  }
}

/**
 * The `task`-scope rate limit is a flood backstop for externally-triggered
 * work: root tasks whose trust is `known` or `unknown`, i.e. anything a third
 * party can create by sending mail. Owner/assistant tasks and internal
 * children are never throttled — schedules and reply children must not stall
 * behind a stranger's burst.
 */
async function underExternalTaskLimit(db: Db): Promise<boolean> {
  const [limit] = await db.select().from(rateLimits).where(eq(rateLimits.scope, 'task'));
  if (!limit) return true;

  const countSince = async (interval: string) => {
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          inArray(tasks.trust, ['known', 'unknown']),
          isNull(tasks.parentTaskId),
          gte(tasks.createdAt, sql`now() - ${interval}::interval`),
        ),
      );
    return Number(row?.n ?? 0);
  };

  if (limit.maxPerHour !== null && (await countSince('1 hour')) >= limit.maxPerHour) return false;
  if (limit.maxPerDay !== null && (await countSince('1 day')) >= limit.maxPerDay) return false;
  return true;
}

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
    /**
     * Owner-armed free-range grant, set atomically at creation (composer toggle,
     * goal automation). Arming is always an authenticated owner action; enqueue
     * callers must never derive this from task content.
     */
    autonomyGrant?: AutonomyGrant;
    /** Caller is inside a larger transaction and will notify only after commit. */
    deferNotification?: boolean;
  },
): Promise<{ task: TaskRow; created: boolean }> {
  const externalRoot =
    (input.event.trust === 'known' || input.event.trust === 'unknown') && !input.parentTaskId;
  if (externalRoot && !(await underExternalTaskLimit(db))) {
    throw new TaskRateLimitError();
  }

  const values = {
    agentId: input.event.agentId,
    conversationId: input.event.conversationId,
    type: input.type,
    title: deriveTaskTitle(input.event),
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
    ...(input.autonomyGrant ? { autonomyGrant: input.autonomyGrant } : {}),
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
export function claimTask(db: Db | TaskLeaseRepository, taskId: string): Promise<TaskLease | null> {
  return leases(db).claim(taskId);
}
/**
 * Extend a live lease before another potentially expensive/side-effecting
 * step. Mutates the local row's fencing token so subsequent CAS writes use
 * the renewed value. A false result means cancellation or another worker won.
 */
export function renewTaskLease(db: Db | TaskLeaseRepository, task: TaskLease): Promise<boolean> {
  return leases(db).renew(task);
}
/** Parse the checkpoint out of a task row (defaults for a fresh task). */
export function taskState(task: TaskRow): TaskState {
  return TaskStateSchema.parse(task.state ?? {});
}

/** Persist the checkpoint. Called once per step, in the same transaction as tool_calls updates. */
export function checkpointTask(
  db: Db | TaskLeaseRepository,
  task: TaskLease,
  state: TaskState,
  extra: TaskCheckpoint = {},
): Promise<boolean> {
  return leases(db).checkpoint(task, state, extra);
}
/** Park for approval — the queue task ends; resume is a fresh enqueue on resolution. */
export async function parkForApproval(
  db: Db | TaskRepository,
  task: TaskLease,
  state: TaskState,
  pending: TaskState['pendingApprovals'],
): Promise<boolean> {
  return lifecycle(db).parkForApproval(task, state, pending);
}

/**
 * Park because a budget ceiling is exhausted (Phase 27): checkpointed like a
 * sleep, but the distinct status makes "waiting on money, not on time or a
 * human" visible on the dashboard. runAfter = the period reset, so parked
 * work auto-resumes when the cap does.
 */
export async function parkForBudget(
  db: Db | TaskRepository,
  task: TaskLease,
  state: TaskState,
  resumeAt: Date,
): Promise<boolean> {
  return lifecycle(db).parkForBudget(task, state, resumeAt);
}

/** Sleep until runAfter (mission wake cadence, retries with backoff, timed waits). */
export async function sleepTask(
  db: Db | TaskRepository,
  task: TaskLease,
  state: TaskState,
  runAfter: Date,
): Promise<boolean> {
  return lifecycle(db).sleepTask(task, state, runAfter);
}

export function completeTask(
  db: Db | TaskRepository,
  task: TaskLease,
  outcome: { status: 'done' | 'failed' | 'cancelled'; progress?: string },
): Promise<boolean>;
/** Administrative cancellation does not need an executor lease. */
export function completeTask(
  db: Db | TaskRepository,
  taskId: string,
  outcome: { status: 'cancelled'; progress?: string },
): Promise<boolean>;
export async function completeTask(
  db: Db | TaskRepository,
  taskOrId: TaskLease | string,
  outcome: { status: 'done' | 'failed' | 'cancelled'; progress?: string },
): Promise<boolean> {
  return lifecycle(db).completeTask(taskOrId, outcome);
}

/** Executor-owned transition for a task that needs operator intervention. */
export async function markTaskNeedsAttention(
  db: Db | TaskRepository,
  task: TaskLease,
  progress: string,
): Promise<boolean> {
  return lifecycle(db).markTaskNeedsAttention(task, progress);
}

/** Executor-owned mission pause. */
export async function parkForEvent(db: Db | TaskRepository, task: TaskLease): Promise<boolean> {
  return lifecycle(db).parkForEvent(task);
}

/**
 * Stamp that the owner has been told this task needs them. Status-guarded so a
 * concurrent wake (which clears the stamp) or a resume can't leave a stale mark;
 * the re-notify sweep only stamps rows still in a waiting-on-owner state.
 */
export async function markAttentionNotified(
  db: Db | TaskRepository,
  taskId: string,
): Promise<boolean> {
  return lifecycle(db).markAttentionNotified(taskId);
}

/**
 * Mark a crashed/failed attempt. Below MAX_ATTEMPTS the task sleeps with
 * bounded exponential backoff; at the cap it dead-letters to needs_attention.
 */
export async function recordFailedAttempt(
  db: Db | TaskRepository,
  task: TaskLease,
  error: string,
): Promise<'retry' | 'dead_letter' | 'lost_lease'> {
  return lifecycle(db).recordFailedAttempt(task, error);
}

/** Resume a parked task: back to pending for the queue. */
export async function wakeTask(
  db: Db | TaskRepository,
  taskId: string,
  budgetIncrease?: { agentId: string; limit: number },
): Promise<boolean> {
  const woken = await lifecycle(db).wakeTask(taskId, budgetIncrease);
  if (!woken) return false;
  getQueueNotifier().notify(woken.id, woken.queueGeneration);
  return true;
}

/** Due work for the local poller / sweeper: pending now, or sleeping past runAfter, or dead leases. */
export async function findDueTasks(db: Db | TaskRepository, limit = 10): Promise<TaskRow[]> {
  return lifecycle(db).findDueTasks(limit);
}
