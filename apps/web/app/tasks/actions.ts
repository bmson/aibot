'use server';

import {
  archiveActivity,
  archiveOldActivity,
  cancelActivity,
  raiseTaskBudget,
  restoreActivity,
  retryActivity,
  revokeTaskAutonomy,
} from '@assistant/application/tasks';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireOwner } from '@/auth';
import { getDb } from '@/lib/server';

function revalidateTaskViews(taskId: string): void {
  revalidatePath('/');
  revalidatePath('/tasks');
  revalidatePath(`/tasks/${taskId}`);
  revalidatePath('/chat', 'layout');
}

/** Re-queue a stuck task (needs_attention → pending). */
export async function retryTask(taskId: string): Promise<void> {
  await requireOwner();
  await retryActivity(getDb(), taskId);
  revalidateTaskViews(taskId);
}

/**
 * Revoke a task's free-range autonomy grant mid-run. Marks the grant revoked so
 * the dispatcher stops downgrading its calls; the next gated call parks normally.
 * Owner-only.
 */
export async function revokeAutonomyGrant(taskId: string): Promise<void> {
  await requireOwner();
  await revokeTaskAutonomy(getDb(), taskId);
  revalidateTaskViews(taskId);
}

/** Raise one task's hard cap and immediately re-queue its checkpointed work. */
export async function raiseTaskBudgetAndRetry(taskId: string, formData: FormData): Promise<void> {
  await requireOwner();
  const requested = Number.parseFloat(String(formData.get('budgetUsdLimit') ?? '').trim());
  await raiseTaskBudget(getDb(), taskId, requested);
  revalidateTaskViews(taskId);
}

export async function cancelTask(taskId: string): Promise<void> {
  await requireOwner();
  await cancelActivity(getDb(), taskId);
  revalidateTaskViews(taskId);
}

/** Hide terminal activity from the default list without deleting any evidence. */
export async function archiveTask(taskId: string): Promise<void> {
  await requireOwner();
  await archiveActivity(getDb(), taskId);
  revalidateTaskViews(taskId);
  redirect('/tasks');
}

/** Restore a hidden activity item to the main Activity list. */
export async function restoreTask(taskId: string): Promise<void> {
  await requireOwner();
  await restoreActivity(getDb(), taskId);
  revalidateTaskViews(taskId);
  redirect(`/tasks/${taskId}`);
}

/** Archive only terminal activity that has been quiet for at least 30 days. */
export async function archiveOldTasks(): Promise<void> {
  await requireOwner();
  await archiveOldActivity(getDb());
  revalidateTaskViews('');
  redirect('/tasks');
}
