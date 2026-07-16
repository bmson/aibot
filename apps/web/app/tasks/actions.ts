'use server';

import { completeTask, wakeTask } from '@assistant/core';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getDb } from '@/lib/server';

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
