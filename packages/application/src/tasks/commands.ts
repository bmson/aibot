import { getAgent } from '@assistant/core/chat';
import { completeTask, wakeTask } from '@assistant/core/workflow/machine';
import { type Db, tasks } from '@assistant/db';
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';

import { terminalTaskStatuses } from './queries.js';

export function retryActivity(db: Db, taskId: string): Promise<boolean> {
  return wakeTask(db, taskId);
}

export async function revokeTaskAutonomy(db: Db, taskId: string): Promise<void> {
  const agent = await getAgent(db);
  const [task] = await db
    .select({ autonomyGrant: tasks.autonomyGrant })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id)))
    .limit(1);
  const grant = task?.autonomyGrant as Record<string, unknown> | null;
  if (!grant || grant.revokedAt) return;
  await db
    .update(tasks)
    .set({
      autonomyGrant: { ...grant, revokedAt: new Date().toISOString() },
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id)));
}

export async function raiseTaskBudget(db: Db, taskId: string, requested: number): Promise<void> {
  if (!Number.isFinite(requested) || requested <= 0 || requested > 10_000) {
    throw new Error('task budget must be between $0.01 and $10,000');
  }
  const agent = await getAgent(db);
  const [task] = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      budgetUsdLimit: tasks.budgetUsdLimit,
      spentUsd: tasks.spentUsd,
    })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id)));
  if (!task) throw new Error('activity item not found');
  if (task.status !== 'needs_attention') throw new Error('only stalled tasks can be retried');
  if (requested <= Number(task.budgetUsdLimit) || requested < Number(task.spentUsd)) {
    throw new Error('new task budget must be above its current cap and spend');
  }
  await db
    .update(tasks)
    .set({ budgetUsdLimit: requested.toFixed(4), updatedAt: new Date() })
    .where(and(eq(tasks.id, task.id), eq(tasks.agentId, agent.id)));
  if (!(await wakeTask(db, task.id))) throw new Error('task could not be retried');
}

export function cancelActivity(db: Db, taskId: string): Promise<boolean> {
  return completeTask(db, taskId, { status: 'cancelled' });
}

export async function archiveActivity(db: Db, taskId: string): Promise<void> {
  const agent = await getAgent(db);
  const [task] = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id)));
  if (!task) throw new Error('activity item not found');
  if (!terminalTaskStatuses.includes(task.status as (typeof terminalTaskStatuses)[number])) {
    throw new Error('only completed, failed, or cancelled activity can be archived');
  }
  await db
    .update(tasks)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(tasks.id, task.id), isNull(tasks.archivedAt)));
}

export async function restoreActivity(db: Db, taskId: string): Promise<void> {
  const agent = await getAgent(db);
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id)));
  if (!task) throw new Error('activity item not found');
  await db
    .update(tasks)
    .set({ archivedAt: null, updatedAt: new Date() })
    .where(eq(tasks.id, task.id));
}

export async function archiveOldActivity(db: Db, olderThanDays = 30): Promise<void> {
  const agent = await getAgent(db);
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  await db
    .update(tasks)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(tasks.agentId, agent.id),
        isNull(tasks.archivedAt),
        inArray(tasks.status, terminalTaskStatuses),
        lt(tasks.updatedAt, cutoff),
      ),
    );
}
