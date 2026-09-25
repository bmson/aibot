export interface EmailExtractionRow {
  id: string;
  agentId: string;
  channelMessageId: string;
  fromEmail: string;
  subject: string;
  category: string;
  importance: number;
}

export interface EmailExtractedFact {
  category: string;
  kind: string;
  content: string;
  contentHash: string;
  embedding: number[];
  importance: number;
  /** Decimal string, capped below first-hand confidence. */
  confidence: string;
  /** Who the fact is about, as the model named them; resolved to a contact by the store. */
  subject: string;
  relationship?: string;
  domain: string;
  validFrom: Date | null;
  expiresAt: Date | null;
}

/** Reads and writes of the `email.extract` job, which turns ingested mail into memory. */
export interface EmailExtractionRepository {
  readonly kind: 'email-extraction-repository';
  /** Ingested mail not yet read into memory, oldest first. */
  pending(limit: number): Promise<EmailExtractionRow[]>;
  /** The stored text of an ingested message, if its message was persisted. */
  messageText(channelMessageId: string): Promise<string | null>;
  /** Mark a row visited, so the ledger drains instead of being re-read. */
  stamp(id: string, now: Date): Promise<void>;
  /** Save one fact from third-party mail; tombstoned content and duplicates are refused. */
  saveFact(input: {
    agentId: string;
    taskId?: string;
    fact: EmailExtractedFact;
    quarantined: boolean;
  }): Promise<'saved' | 'duplicate' | 'tombstoned'>;
  /** Save a quarantined occasion for a named person; null when the subject is no one. */
  saveOccasion(input: {
    agentId: string;
    subject: string;
    kind: 'birthday' | 'anniversary' | 'custom';
    label: string;
    month: number;
    day: number;
    year: number | null;
    notes: string;
  }): Promise<boolean | null>;
  pendingCount(): Promise<number>;
}
