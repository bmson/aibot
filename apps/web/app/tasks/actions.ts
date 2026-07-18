'use server';

import { completeTask, getAgent, wakeTask } from '@assistant/core';
import { tasks } from '@assistant/db';
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireOwner } from '@/auth';
import { getDb } from '@/lib/server';

const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'];
const ARCHIVE_AFTER_DAYS = 30;

function revalidateTaskViews(taskId: string): void {
  revalidatePath('/');
  revalidatePath('/tasks');
  revalidatePath(`/tasks/${taskId}`);
}

/** Re-queue a stuck task (needs_attention → pending). */
export async function retryTask(taskId: string): Promise<void> {
  await requireOwner();
  await wakeTask(getDb(), taskId);
  revalidateTaskViews(taskId);
}

export async function cancelTask(taskId: string): Promise<void> {
  await requireOwner();
  await completeTask(getDb(), taskId, { status: 'cancelled' });
  revalidateTaskViews(taskId);
}

/** Hide terminal activity from the default list without deleting any evidence. */
export async function archiveTask(taskId: string): Promise<void> {
  await requireOwner();
  const db = getDb();
  const agent = await getAgent(db);
  const [task] = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agent.id)));
  if (!task) throw new Error('activity item not found');
  if (!TERMINAL_TASK_STATUSES.includes(task.status)) {
    throw new Error('only completed, failed, or cancelled activity can be archived');
  }
  await db
    .update(tasks)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(tasks.id, task.id), isNull(tasks.archivedAt)));
  revalidateTaskViews(task.id);
  redirect('/tasks');
}

/** Restore a hidden activity item to the main Activity list. */
export async function restoreTask(taskId: string): Promise<void> {
  await requireOwner();
  const db = getDb();
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
  revalidateTaskViews(task.id);
  redirect(`/tasks/${task.id}`);
}

/** Archive only terminal activity that has been quiet for at least 30 days. */
export async function archiveOldTasks(): Promise<void> {
  await requireOwner();
  const db = getDb();
  const agent = await getAgent(db);
  const cutoff = new Date(Date.now() - ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000);
  await db
    .update(tasks)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(tasks.agentId, agent.id),
        isNull(tasks.archivedAt),
        inArray(tasks.status, TERMINAL_TASK_STATUSES),
        lt(tasks.updatedAt, cutoff),
      ),
    );
  revalidateTaskViews('');
  redirect('/tasks');
}
