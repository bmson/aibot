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
