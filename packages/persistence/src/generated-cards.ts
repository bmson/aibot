import type { Records } from './records.js';

export interface GeneratedCardPersistInput {
  agentId: string;
  conversationId?: string | null;
  id: string;
  revisionId: string;
  sourceFingerprint: string;
  sourceLabel: string;
  spec: unknown;
  expiresAt: Date | null;
  targetCardId?: string;
  touch?: boolean;
}

export interface GeneratedCardPersistResult {
  card: Records['generatedCards'];
  revision: Records['generatedCardRevisions'];
}

export interface GeneratedCardRecord {
  card: Records['generatedCards'];
  revision: Records['generatedCardRevisions'];
}

export interface GeneratedCardRefresh {
  id: string;
  cardId: string;
  status: string;
  createdAt: Date;
}

export interface GeneratedCardRepository {
  readonly kind: 'generated-card-repository';
  /** Create or revise by (agentId, sourceFingerprint), atomically and idempotently. */
  createOrRevise(input: GeneratedCardPersistInput): Promise<GeneratedCardPersistResult>;
  /** Read one owner-scoped active card and its current immutable revision. */
  get(agentId: string, cardId: string): Promise<GeneratedCardRecord | null>;
  /** Owner-scoped current active cards with their current immutable revision. */
  list(agentId: string, now?: Date, ids?: string[]): Promise<GeneratedCardRecord[]>;
  /** Latest refresh attempts for the requested owner-scoped cards. */
  listRefreshes(agentId: string, cardIds: string[]): Promise<GeneratedCardRefresh[]>;
  /** Dismiss only a card belonging to the requested agent. */
  dismiss(agentId: string, cardId: string, now?: Date): Promise<boolean>;
}
