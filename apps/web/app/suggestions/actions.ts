'use server';

import {
  decideSuggestion,
  type SuggestionDecision,
  snoozeSuggestionUntil,
} from '@assistant/application/suggestions';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getDb } from '@/lib/server';

/**
 * Accept or dismiss a suggestion from its inline card.
 *
 * Accepting creates work rather than performing it, so the task views are
 * revalidated alongside the chat: the owner should see the thing they just
 * asked for appear where work lives.
 */
export async function decideSuggestionInline(
  suggestionId: string,
  decision: SuggestionDecision,
): Promise<{ ok: boolean; taskId?: string; error?: string }> {
  await requireOwner();
  const result = await decideSuggestion(getDb(), suggestionId, decision);
  revalidatePath('/');
  revalidatePath('/tasks');
  revalidatePath('/chat', 'layout');
  return result.ok
    ? { ok: true, ...(result.taskId ? { taskId: result.taskId } : {}) }
    : { ok: false, error: result.reason };
}

/**
 * Put a suggestion down until tomorrow without answering it. "Later" means
 * later: the core snooze carries the expiry out with it, and the hydrated
 * card reads as a settled receipt until the snooze elapses.
 */
export async function snoozeSuggestionInline(
  suggestionId: string,
): Promise<{ ok: boolean; error?: string }> {
  await requireOwner();
  const result = await snoozeSuggestionUntil(getDb(), suggestionId);
  revalidatePath('/chat', 'layout');
  return result.ok ? { ok: true } : { ok: false, error: result.reason };
}
