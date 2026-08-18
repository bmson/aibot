import {
  acceptSuggestion,
  dismissSuggestion,
  listOpenSuggestions,
  snoozeSuggestion,
} from '@assistant/core';
import type { Db } from '@assistant/db';

/**
 * Owner-facing use cases for the suggestion surface.
 *
 * Every outcome is a value, never a throw: these run behind a button in the
 * chat, and a suggestion that was already answered in another tab is an
 * ordinary thing to happen, not an error page.
 */

export interface SuggestionView {
  id: string;
  summary: string;
  proposedAction: string;
  status: string;
  createdAt: string;
}

export type SuggestionDecision = 'accepted' | 'dismissed';

export interface DecideSuggestionResult {
  ok: boolean;
  /** Set when accepting created work, so the UI can link to it. */
  taskId?: string;
  reason?: string;
}

export async function decideSuggestion(
  db: Db,
  suggestionId: string,
  decision: SuggestionDecision,
): Promise<DecideSuggestionResult> {
  if (decision === 'dismissed') {
    const dismissed = await dismissSuggestion(db, suggestionId);
    return dismissed ? { ok: true } : { ok: false, reason: 'This suggestion is no longer open.' };
  }
  const outcome = await acceptSuggestion(db, suggestionId);
  return outcome.ok ? { ok: true, taskId: outcome.taskId } : { ok: false, reason: outcome.reason };
}

/** Put a suggestion down until a chosen time (defaults to this time tomorrow). */
export async function snoozeSuggestionUntil(
  db: Db,
  suggestionId: string,
  until?: Date,
): Promise<DecideSuggestionResult> {
  const when = until ?? new Date(Date.now() + 24 * 3600 * 1000);
  const snoozed = await snoozeSuggestion(db, suggestionId, when);
  return snoozed ? { ok: true } : { ok: false, reason: 'This suggestion is no longer open.' };
}

export async function getOpenSuggestions(db: Db, agentId: string): Promise<SuggestionView[]> {
  const rows = await listOpenSuggestions(db, agentId);
  return rows.map((row) => ({
    id: row.id,
    summary: row.summary,
    proposedAction: row.proposedAction,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  }));
}
