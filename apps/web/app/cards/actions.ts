'use server';

import { dismissSavedCard, requestSavedCardRefresh } from '@assistant/application/cards';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getAgentIdentity, getDb } from '@/lib/server';

export async function dismissCard(formData: FormData): Promise<void> {
  await requireOwner();
  const cardId = String(formData.get('cardId') ?? '');
  const agent = await getAgentIdentity();
  if (!agent.id || !cardId) return;
  await dismissSavedCard(getDb(), agent.id, cardId);
  revalidatePath('/cards');
}

/** Refresh a saved object; the task updates its existing card after fresh source reads. */
export async function refreshSavedCardInline(
  cardId: string,
): Promise<{ ok: boolean; taskId?: string; error?: string }> {
  await requireOwner();
  const agent = await getAgentIdentity();
  if (
    !agent.id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cardId)
  ) {
    return { ok: false, error: 'This saved card is unavailable.' };
  }
  const result = await requestSavedCardRefresh(getDb(), agent.id, cardId);
  revalidatePath('/cards');
  revalidatePath('/chat', 'layout');
  return result.ok ? { ok: true, taskId: result.taskId } : { ok: false, error: result.error };
}
