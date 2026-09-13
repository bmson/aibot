import type {
  Records,
  TaskBudgetIncrease,
  TaskCreateInput,
  TaskLease,
  TaskOutcome,
  TaskRepository,
} from '@assistant/persistence';
import { Filter } from '@google-cloud/firestore';
import { createWakeIntent } from './outbox.js';
import { decodeRecord, encodeRecord } from './store.js';
import { createTask } from './task-creation.js';
import { FirestoreTaskLeaseRepository } from './tasks.js';

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const WAKEABLE = new Set([
  'waiting_approval',
  'waiting_event',
  'sleeping',
  'waiting_budget',
  'needs_attention',
]);
type Task = Records['tasks'];

export class FirestoreTaskRepository
  extends FirestoreTaskLeaseRepository
  implements TaskRepository
{
  createTask(input: TaskCreateInput) {
    return createTask(this.store, input);
  }
  async persistPlan(task: TaskLease, plan: unknown) {
    return Boolean(await this.change(task.id, () => ({ plan }), task));
  }
  private async change(
    id: string,
    update: (task: Task, now: Date) => Partial<Task> | null,
    lease?: TaskLease,
  ): Promise<Task | null> {
    return this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('tasks', id);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return null;
      const row = decodeRecord<Task>(snapshot.data());
      const now = this.store.now();
      if (
        lease &&
        (row.agentId !== lease.agentId ||
          row.status !== 'running' ||
          !lease.leaseToken ||
          row.leaseToken !== lease.leaseToken ||
          !row.lockedUntil ||
          row.lockedUntil <= now)
      )
        return null;
      const patch = update(row, now);
      if (!patch) return null;
      const result = { ...row, ...patch, updatedAt: patch.updatedAt ?? now };
      tx.update(ref, encodeRecord({ ...patch, updatedAt: result.updatedAt }));
      if (
        result.queueGeneration !== row.queueGeneration &&
        ['pending', 'sleeping', 'waiting_budget'].includes(result.status)
      ) {
        createWakeIntent(tx, this.store, {
          taskId: id,
          generation: result.queueGeneration,
          availableAt: result.runAfter ?? now,
        });
      }
      return result;
    });
  }

  async parkForApproval(task: TaskLease, state: Record<string, unknown>, pending: unknown[]) {
    return Boolean(
      await this.change(
        task.id,
        () => ({
          status: 'waiting_approval',
          state: { ...state, pendingApprovals: pending },
          runAfter: null,
          lockedUntil: null,
          leaseToken: null,
          attempt: 0,
        }),
        task,
      ),
    );
  }
  async parkForBudget(task: TaskLease, state: Record<string, unknown>, resumeAt: Date) {
    return this.parkUntil(task, state, resumeAt, 'waiting_budget');
  }
  async sleepTask(task: TaskLease, state: Record<string, unknown>, runAfter: Date) {
    return this.parkUntil(task, state, runAfter, 'sleeping');
  }
  private async parkUntil(
    task: TaskLease,
    state: Record<string, unknown>,
    runAfter: Date,
    status: 'sleeping' | 'waiting_budget',
  ) {
    if (!Number.isFinite(runAfter.getTime())) throw new Error('Invalid task resume time');
    return Boolean(
      await this.change(
        task.id,
        (row) => ({
          status,
          state,
          runAfter,
          lockedUntil: null,
          leaseToken: null,
          queueGeneration: row.queueGeneration + 1,
          attempt: 0,
          ...(status === 'sleeping' ? { reclaimCount: 0 } : {}),
        }),
        task,
      ),
    );
  }
  async completeTask(task: TaskLease | string, outcome: TaskOutcome) {
    if (typeof task === 'string' && outcome.status !== 'cancelled')
      throw new Error('Administrative completion requires cancellation');
    return Boolean(
      await this.change(
        typeof task === 'string' ? task : task.id,
        (row) =>
          TERMINAL.has(row.status)
            ? null
            : {
                status: outcome.status,
                progress: outcome.progress ?? row.progress,
                lockedUntil: null,
                leaseToken: null,
                runAfter: null,
                attempt: 0,
              },
        typeof task === 'string' ? undefined : task,
      ),
    );
  }
  async markTaskNeedsAttention(task: TaskLease, progress: string) {
    return Boolean(
      await this.change(
        task.id,
        () => ({
          status: 'needs_attention',
          progress: progress.slice(0, 500),
          lockedUntil: null,
          leaseToken: null,
          runAfter: null,
          attempt: 0,
          attentionNotifiedAt: null,
        }),
        task,
      ),
    );
  }
  async parkForEvent(task: TaskLease) {
    return Boolean(
      await this.change(
        task.id,
        () => ({
          status: 'waiting_event',
          lockedUntil: null,
          leaseToken: null,
          runAfter: null,
          attempt: 0,
          attentionNotifiedAt: null,
        }),
        task,
      ),
    );
  }
  async markAttentionNotified(taskId: string) {
    return Boolean(
      await this.change(taskId, (row, now) =>
        ['needs_attention', 'waiting_event'].includes(row.status)
          ? { attentionNotifiedAt: now, updatedAt: row.updatedAt }
          : null,
      ),
    );
  }
  async recordFailedAttempt(
    task: TaskLease,
    error: string,
  ): Promise<'retry' | 'dead_letter' | 'lost_lease'> {
    const result = await this.change(
      task.id,
      (row, now) => {
        const attempt = row.attempt + 1;
        return {
          attempt,
          status: attempt >= 8 ? 'needs_attention' : 'sleeping',
          progress: `attempt ${attempt} failed: ${error.slice(0, 500)}`,
          runAfter:
            attempt >= 8
              ? null
              : new Date(now.getTime() + Math.min(300, 5 * 2 ** row.attempt) * 1000),
          lockedUntil: null,
          leaseToken: null,
          attentionNotifiedAt: null,
          queueGeneration: row.queueGeneration + 1,
        };
      },
      task,
    );
    return !result ? 'lost_lease' : result.status === 'needs_attention' ? 'dead_letter' : 'retry';
  }
  async wakeTask(taskId: string, budgetIncrease?: TaskBudgetIncrease) {
    if (
      budgetIncrease &&
      (!Number.isFinite(budgetIncrease.limit) ||
        budgetIncrease.limit < 0.01 ||
        budgetIncrease.limit > 10_000)
    )
      return null;
    const result = await this.change(taskId, (row) => {
      if (!WAKEABLE.has(row.status)) return null;
      if (
        budgetIncrease &&
        (budgetIncrease.agentId !== row.agentId ||
          row.status !== 'needs_attention' ||
          budgetIncrease.limit <= Number(row.budgetUsdLimit) ||
          budgetIncrease.limit < Number(row.spentUsd))
      )
        return null;
      const state =
        row.state && typeof row.state === 'object' && !Array.isArray(row.state)
          ? ({ ...row.state } as Record<string, unknown>)
          : row.state;
      if (row.status === 'needs_attention' && state && typeof state === 'object')
        delete (state as Record<string, unknown>).pendingFinal;
      return {
        status: 'pending',
        state,
        runAfter: null,
        lockedUntil: null,
        leaseToken: null,
        queueGeneration: row.queueGeneration + 1,
        attempt: 0,
        attentionNotifiedAt: null,
        ...(budgetIncrease ? { budgetUsdLimit: budgetIncrease.limit.toFixed(4) } : {}),
      };
    });
    return result ? { id: result.id, queueGeneration: result.queueGeneration } : null;
  }
  async findDueTasks(limit = 10): Promise<Task[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error('Invalid due-task batch');
    const now = this.store.now();
    const expired = await this.store
      .collection('tasks')
      .where('status', '==', 'running')
      .where(
        Filter.or(Filter.where('lockedUntil', '==', null), Filter.where('lockedUntil', '<=', now)),
      )
      .orderBy('lockedUntil')
      .limit(limit)
      .get();
    for (const snapshot of expired.docs) {
      await this.change(String(snapshot.get('id')), (row, at) => {
        // Recheck expiry under the transaction: a renewal after the query must win.
        if (row.status !== 'running' || (row.lockedUntil && row.lockedUntil > at)) return null;
        const reclaimCount = row.reclaimCount + 1;
        return {
          reclaimCount,
          updatedAt: row.updatedAt,
          status: reclaimCount >= 8 ? 'needs_attention' : 'pending',
          progress:
            reclaimCount >= 8
              ? `stopped after a worker repeatedly failed to complete a step without recording progress (hung or killed ${reclaimCount} times)`
              : row.progress,
          runAfter: reclaimCount >= 8 ? null : row.runAfter,
          lockedUntil: null,
          leaseToken: null,
          attentionNotifiedAt: null,
          queueGeneration: row.queueGeneration + 1,
        };
      });
    }
    const due = await dueTasksQuery(this.store, now, limit).get();
    return due.docs.map((doc) => decodeRecord<Task>(doc.data()));
  }
}

/** Shared with live Query Explain validation so diagnostics use the runtime query. */
export function dueTasksQuery(
  store: import('./store.js').InstallationStore,
  now: Date,
  limit: number,
) {
  return store
    .collection('tasks')
    .where(
      Filter.or(
        Filter.and(
          Filter.where('status', '==', 'pending'),
          Filter.or(Filter.where('runAfter', '==', null), Filter.where('runAfter', '<=', now)),
        ),
        Filter.and(
          Filter.where('status', 'in', ['sleeping', 'waiting_budget']),
          Filter.where('runAfter', '<=', now),
        ),
      ),
    )
    .orderBy('updatedAt')
    .limit(limit);
}
