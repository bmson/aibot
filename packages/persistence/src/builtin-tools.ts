import type { SituationPackView } from './situations-schema.js';

/** Occasion fields the `occasions.save` tool records for one named person. */
export interface OccasionToolSaveInput {
  agentId: string;
  /** The person's name as the model gave it; the adapter resolves or creates the contact. */
  subject: string;
  kind: 'birthday' | 'anniversary' | 'custom';
  label: string;
  month: number;
  day: number;
  year: number | null;
  leadDays: number;
  notes: string;
  originTrust: string;
  quarantined: boolean;
  source: string;
}

/** A non-quarantined occasion joined to its person's current name. */
export interface OccasionToolRow {
  id: string;
  contactId: string;
  contactName: string;
  kind: string;
  label: string;
  month: number;
  day: number;
  year: number | null;
  recurrence: string;
  leadDays: number;
  notes: string;
}

/** Storage behind `occasions.save` and `occasions.list`. */
export interface OccasionToolRepository {
  /** Null when the subject resolves to no person. `saved` is false when an existing date merged. */
  save(input: OccasionToolSaveInput): Promise<{ saved: boolean } | null>;
  list(agentId: string): Promise<OccasionToolRow[]>;
}

export interface ContactLookupRow {
  name: string;
  emails: string[];
  phones: string[];
  relationship: string;
}

/** Read-only name lookup behind `contacts.lookup`. It never creates a contact. */
export interface ContactLookupRepository {
  findByName(input: { agentId: string; query: string }): Promise<ContactLookupRow[]>;
}

export interface ConversationSearchMatch {
  conversationId: string;
  text: string;
  createdAt: Date;
}

/** Owner-scoped message search behind `conversations.search`. */
export interface ConversationSearchRepository {
  semantic(input: {
    agentId: string;
    embedding: number[];
    limit: number;
  }): Promise<Array<ConversationSearchMatch & { similarity: number }>>;
  /** Case-insensitive substring match, newest first. */
  text(input: {
    agentId: string;
    query: string;
    limit: number;
  }): Promise<ConversationSearchMatch[]>;
}

export interface SituationPackSource {
  kind: 'card' | 'commitment';
  id: string;
  title: string;
  lane: 'plan' | 'i_owe' | 'waiting_on';
}

export interface SituationDecisionMatch {
  id: string;
  option: string;
  outcome: 'chosen' | 'rejected';
  reason: string;
  scope: 'situation' | 'preference';
  confirmed: boolean;
  packId: string;
  packTitle: string;
}

export type SituationCommandResult =
  | {
      ok: true;
      packId: string;
      preview?: {
        id: string;
        packId: string;
        baseVersion: number;
        before: unknown;
        after: unknown;
        affectedIds: string[];
        unknowns: string[];
        expiresAt: string;
      };
    }
  | { ok: false; error: string };

/** Owner-scoped situation packs behind the `situations.*` tools. */
export interface SituationToolRepository {
  list(agentId: string): Promise<SituationPackView[]>;
  get(agentId: string, packId: string): Promise<SituationPackView | null>;
  sources(agentId: string): Promise<SituationPackSource[]>;
  decisions(agentId: string, query: string, packId?: string): Promise<SituationDecisionMatch[]>;
  /** Tool commands never carry owner confirmation. */
  command(agentId: string, input: unknown): Promise<SituationCommandResult>;
}
