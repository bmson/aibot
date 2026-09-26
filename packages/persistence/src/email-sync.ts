import type { Records } from './records.js';

export interface EmailSyncState {
  lastHistoryId: bigint | null;
  /** The durable drain cursor; empty or null when no drain is in progress. */
  cursor: unknown;
}

export type EmailIngestRecord = Pick<
  Records['emailIngest'],
  'id' | 'conversationId' | 'importance' | 'category' | 'contentTrust' | 'triaged'
>;

export type NewEmailIngest = Pick<
  Records['emailIngest'],
  | 'agentId'
  | 'conversationId'
  | 'channelMessageId'
  | 'fromEmail'
  | 'fromName'
  | 'subject'
  | 'contentTrust'
  | 'authenticated'
  | 'category'
  | 'importance'
  | 'actionable'
  | 'reason'
  | 'dates'
>;

/**
 * Gmail sync's own state: the owner mailbox, its history cursor, the
 * single-flight lock, email thread conversations, and the `emailIngest`
 * ledger the briefing, pulse and memory extraction read.
 */
export interface EmailSyncRepository {
  readonly kind: 'email-sync-repository';
  /** The owner agent, its name for the From header, and the mailbox it syncs. */
  mailbox(): Promise<{ agentId: string; name: string; email: string }>;
  /** Addresses of owner and known contacts, lowercased. */
  contactTrust(): Promise<Array<{ email: string; trust: 'owner' | 'known' }>>;
  syncState(mailbox: string): Promise<EmailSyncState | null>;
  /** Raise the history baseline (never lower it), creating the state on first sync. */
  raiseBaseline(mailbox: string, historyId: bigint): Promise<void>;
  saveCursor(mailbox: string, cursor: unknown): Promise<void>;
  /** Finish a drain: raise the baseline to the drain's target and clear the cursor. */
  completeDrain(mailbox: string, targetHistoryId: bigint): Promise<void>;
  setWatchExpiration(mailbox: string, expiration: Date): Promise<void>;
  /**
   * Run while holding the cross-instance mailbox lock. Returns null without
   * running when another instance holds it.
   */
  withLock<T>(run: () => Promise<T>): Promise<{ value: T } | null>;
  /** The stored inbound message for a Gmail id, if one was persisted. */
  inboundMessage(
    channelMessageId: string,
  ): Promise<{ conversationId: string; origin: string } | null>;
  /** Whether any task already carries this external event id. */
  hasTaskForEvent(externalEventId: string): Promise<boolean>;
  /** The conversation bound to an email thread, created with its binding on first contact. */
  conversationForThread(
    agentId: string,
    threadId: string,
    trust: string,
    subject: string,
  ): Promise<string>;
  ingestRecord(channelMessageId: string): Promise<EmailIngestRecord | null>;
  /** Record a verdict once per Gmail id. Returns its id, or null when it already existed. */
  recordIngest(row: NewEmailIngest): Promise<string | null>;
  /** Ingest rows marked triaged since `since`, for the daily triage ceiling. */
  triagedSince(since: Date): Promise<number>;
  markTriaged(ingestId: string, now: Date): Promise<void>;
  /**
   * Where an email conversation replies: its channel, the Gmail thread it is
   * bound to, and the trigger of its earliest owner-trust email_triage task.
   */
  replyThread(conversationId: string): Promise<{
    channel: string;
    threadId: string | null;
    ownerOriginTrigger: unknown;
  } | null>;
}
