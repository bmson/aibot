import {
  acceptSuggestion,
  dismissSuggestion,
  listOpenSuggestions,
  snoozeSuggestion,
  suggestionExpiresAt,
} from '@assistant/core';
import { type Db, suggestions } from '@assistant/db';
import { eq } from 'drizzle-orm';

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
  /** Authoritative wake time, also returned when retrying an existing snooze. */
  snoozedUntil?: string;
  reason?: string;
}

async function currentSuggestion(db: Db, suggestionId: string) {
  const [row] = await db
    .select({
      status: suggestions.status,
      acceptedTaskId: suggestions.acceptedTaskId,
      snoozedUntil: suggestions.snoozedUntil,
      expiresAt: suggestions.expiresAt,
      origin: suggestions.origin,
      proposedAction: suggestions.proposedAction,
    })
    .from(suggestions)
    .where(eq(suggestions.id, suggestionId));
  return row;
}

export async function decideSuggestion(
  db: Db,
  suggestionId: string,
  decision: SuggestionDecision,
): Promise<DecideSuggestionResult> {
  if (decision === 'dismissed') {
    const dismissed = await dismissSuggestion(db, suggestionId);
    if (dismissed || (await currentSuggestion(db, suggestionId))?.status === 'dismissed') {
      return { ok: true };
    }
    return { ok: false, reason: 'This suggestion is no longer open.' };
  }
  const outcome = await acceptSuggestion(db, suggestionId);
  if (outcome.ok) return { ok: true, taskId: outcome.taskId };
  // A lost response or a racing tap may retry a committed decision. Report
  // that same result without creating any additional work.
  const current = await currentSuggestion(db, suggestionId);
  if (current?.status === 'accepted' && current.acceptedTaskId) {
    return { ok: true, taskId: current.acceptedTaskId };
  }
  return { ok: false, reason: outcome.reason };
}

/** Put a suggestion down until a chosen time (defaults to this time tomorrow). */
export async function snoozeSuggestionUntil(
  db: Db,
  suggestionId: string,
  until?: Date,
): Promise<DecideSuggestionResult> {
  const when = until ?? new Date(Date.now() + 24 * 3600 * 1000);
  const now = new Date();
  if (!Number.isFinite(when.getTime()) || when <= now) {
    return { ok: false, reason: 'Choose a future time for this suggestion.' };
  }
  const snoozed = await snoozeSuggestion(db, suggestionId, when);
  if (snoozed) return { ok: true, snoozedUntil: when.toISOString() };
  const current = await currentSuggestion(db, suggestionId);
  if (
    current?.status === 'snoozed' &&
    current.snoozedUntil &&
    current.snoozedUntil > now &&
    suggestionExpiresAt(current) > now
  ) {
    return { ok: true, snoozedUntil: current.snoozedUntil.toISOString() };
  }
  if (
    current &&
    (current.status === 'pending' || current.status === 'snoozed') &&
    suggestionExpiresAt(current) > now &&
    suggestionExpiresAt(current) <= when
  ) {
    return {
      ok: false,
      reason: 'This suggestion needs a decision sooner. Please accept or dismiss it now.',
    };
  }
  return { ok: false, reason: 'This suggestion is no longer open.' };
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
