'use server';

import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getApplication } from '@/lib/server';

function revalidateSettings(): void {
  revalidatePath('/settings');
}

/** Editable agent identity: timezone, locale, signature. */
export async function updateAgentSettings(input: {
  timezone: string;
  locale: string;
  signature: string;
}): Promise<{ error?: string }> {
  await requireOwner();
  const result = await getApplication().updateSettings(input);
  if (result.error) return result;
  revalidateSettings();
  return {};
}

/** Pause/resume a proactive schedule. Re-enabling recomputes next_run_at on the next sweep. */
export async function setScheduleEnabled(scheduleId: string, enabled: boolean): Promise<void> {
  await requireOwner();
  await getApplication().setScheduleEnabled(scheduleId, enabled);
  revalidateSettings();
}

/** Update spend caps for all three scopes; invalid or out-of-range values are skipped. */
export async function updateBudgets(formData: FormData): Promise<void> {
  await requireOwner();
  const values: Partial<Record<'task_default' | 'daily' | 'monthly', number>> = {};
  for (const scope of ['task_default', 'daily', 'monthly'] as const) {
    const value = Number.parseFloat(String(formData.get(scope) ?? '').trim());
    if (Number.isFinite(value)) values[scope] = value;
  }
  await getApplication().updateBudgets(values);
  revalidateSettings();
  revalidatePath('/costs');
}

/** Enable/disable a standing approval rule. */
export async function setPolicyEnabled(policyId: string, enabled: boolean): Promise<void> {
  await requireOwner();
  await getApplication().setPolicyEnabled(policyId, enabled);
  revalidateSettings();
}

/** Remove a standing approval rule entirely — the tool goes back to asking. */
export async function deletePolicy(policyId: string): Promise<void> {
  await requireOwner();
  await getApplication().deletePolicy(policyId);
  revalidateSettings();
}
