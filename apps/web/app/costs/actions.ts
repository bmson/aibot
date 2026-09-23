'use server';

import { updateBudgetCaps } from '@assistant/application/costs';
import { loadConfig } from '@assistant/config';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getDb } from '@/lib/server';

/** Raise/lower the default task, daily, and monthly hard caps. */
export async function updateCaps(formData: FormData): Promise<void> {
  await requireOwner();
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore')
    throw new Error('Cost cap editing is unavailable in Firestore mode');
  await updateBudgetCaps(getDb(), {
    task_default: String(formData.get('task_default') ?? ''),
    daily: String(formData.get('daily') ?? ''),
    monthly: String(formData.get('monthly') ?? ''),
  });
  revalidatePath('/costs');
}
