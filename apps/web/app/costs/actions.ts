'use server';

import { budgets } from '@assistant/db';
import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getDb } from '@/lib/server';

/** Raise/lower the default task, daily, and monthly hard caps. */
export async function updateCaps(formData: FormData): Promise<void> {
  await requireOwner();
  const db = getDb();
  for (const scope of ['task_default', 'daily', 'monthly'] as const) {
    const raw = String(formData.get(scope) ?? '').trim();
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value) || value <= 0 || value > 10000) continue;
    await db
      .update(budgets)
      .set({ limitUsd: value.toFixed(2), updatedAt: sql`now()` })
      .where(eq(budgets.scope, scope));
  }
  revalidatePath('/costs');
}
