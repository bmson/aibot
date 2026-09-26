import type { CodeJobLease } from './code-jobs.js';

/** One message of a transcript the extraction jobs read. */
export interface ExtractionMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: Date;
}

/** A recently active conversation and its newest messages, oldest first. */
export interface ExtractionConversation {
  conversationId: string;
  trust: string;
  messages: ExtractionMessage[];
}

export interface ExtractedMemoryFact {
  content: string;
  contentHash: string;
  embedding: number[];
  category: 'knowledge' | 'experience';
  kind: 'fact' | 'preference' | 'person' | 'project' | 'episode';
  importance: number;
  /** Two-decimal string, as stored. */
  confidence: string;
  domain: string;
  validFrom: Date | null;
  expiresAt: Date | null;
  /** Who the fact is about: "owner", a person's name, or an assistant alias. */
  subject: string;
  relationship: string;
}

export interface ExtractedOccasion {
  subject: string;
  kind: 'birthday' | 'anniversary' | 'custom';
  label: string;
  month: number;
  day: number;
  year: number | null;
  notes: string;
}

export interface ExtractedCommitment {
  kind: 'decision' | 'question' | 'promise' | 'waiting_on';
  title: string;
  details: string;
  nextAction: string;
  dueAt: Date | null;
  /** Two-decimal string, as stored. */
  confidence: string;
  contentHash: string;
}

export interface MemoryExtractionApplied {
  saved: number;
  quarantined: number;
  duplicates: number;
  tombstoned: number;
  contactsCreated: number;
  occasionsSaved: number;
}

export interface CommitmentExtractionApplied {
  saved: number;
  duplicates: number;
  resolved: number;
}

/**
 * Storage for the nightly `memory.extract` job (facts, occasions and open
 * loops mined from recent conversations).
 *
 * Each conversation's outcome commits in one transaction together with a
 * per-task checkpoint entry. A task whose lease is reclaimed mid-run resumes
 * without re-reading, re-paying for, or re-saving a conversation it already
 * finished, and a writer that lost its lease cannot commit at all.
 */
export interface MemoryExtractionRepository {
  readonly kind: 'memory-extraction-repository';
  /**
   * Conversations of this owner with a user or assistant message since
   * `since`, most recently active first. Each carries its newest
   * `maxMessages` user/assistant messages longer than `minTextLength - 1`
   * characters, oldest first.
   */
  recentConversations(input: {
    agentId: string;
    since: Date;
    maxConversations: number;
    maxMessages: number;
    minTextLength: number;
  }): Promise<ExtractionConversation[]>;
  /** Every contact's display name, for attributing facts. */
  knownContactNames(agentId: string): Promise<string[]>;
  /** Checkpoint keys this task has already committed. */
  completedSteps(agentId: string, lease: CodeJobLease): Promise<string[]>;
  /** Save one conversation's facts and occasions, once per checkpoint key. */
  applyMemories(input: {
    agentId: string;
    lease: CodeJobLease;
    checkpointKey: string;
    originTrust: string;
    quarantined: boolean;
    facts: ExtractedMemoryFact[];
    occasions: ExtractedOccasion[];
  }): Promise<MemoryExtractionApplied | null>;
  /** The owner's open and snoozed loops, most recently touched first. */
  activeCommitments(agentId: string, limit: number): Promise<Array<{ id: string; title: string }>>;
  /**
   * Save one conversation's open loops and resolve the ones it closed, once
   * per checkpoint key. A loop whose active twin already exists refreshes it
   * without touching `updatedAt`, so re-extraction never resets its idle clock.
   */
  applyCommitments(input: {
    agentId: string;
    lease: CodeJobLease;
    checkpointKey: string;
    conversationId: string;
    sourceMessageId: string | null;
    resolveIds: string[];
    resolution: string;
    commitments: ExtractedCommitment[];
  }): Promise<CommitmentExtractionApplied | null>;
}
