import type { Records } from './records.js';

export type SuggestionRecord = Records['suggestions'];

export interface CreateSuggestionRecord {
  agentId: string;
  conversationId?: string;
  summary: string;
  proposedAction: string;
  /** Stable per proposal, so a producer that re-runs proposes nothing twice. */
  sourceRef: string;
  origin: string;
  expiresAt: Date;
}

/** Proposals a producer offers the owner as one-tap suggestions. */
export interface SuggestionRepository {
  readonly kind: 'suggestion-repository';
  /**
   * Record a proposal unless one with the same `(agentId, sourceRef)` exists,
   * whatever its status. Returns the new row, or null when it already existed.
   */
  create(input: CreateSuggestionRecord): Promise<SuggestionRecord | null>;
  /** Pending or snoozed, unexpired, and not snoozed past `now`; oldest first. */
  listOpen(agentId: string, now: Date): Promise<SuggestionRecord[]>;
}
