/**
 * Write-time supersession: the storage half.
 *
 * A correction the owner just made should stop the fact it corrects from
 * answering questions immediately, rather than waiting for the nightly
 * consolidation sweep to reach that entity. The decision of *which* fact a
 * write may retire is policy and lives in core; everything here is the bounded
 * set of reads and writes that decision needs.
 */

/** Cosine similarity a live fact needs before it is a candidate at all. */
export const SUPERSEDE_SIMILARITY_FLOOR = 0.78;

/** At most this many live facts are considered for one write. */
export const MAX_SUPERSEDE_CANDIDATES = 6;

/**
 * The fact fields the precedence rule reads. Deliberately not the whole row:
 * a supersession decision turns on how well-supported a fact is and who said
 * so, never on its embedding or its bookkeeping columns.
 */
export interface SupersedeFact {
  id: string;
  content: string;
  /** Numeric-as-string, exactly as the ledger stores it. */
  confidence: string;
  ownerConfirmed: boolean;
  createdAt: Date;
}

/** The written fact, plus what scoping its candidate search needs. */
export interface WrittenFact extends SupersedeFact {
  /** Null when the fact is about no one in particular. */
  subjectContactId: string | null;
  /** Absent when the row was stored without one and cannot be compared. */
  embedding: number[] | null;
}

export interface SupersedeCandidatesInput {
  agentId: string;
  /** Excluded from its own candidate list. */
  newFactId: string;
  embedding: number[];
  subjectContactId: string | null;
}

export interface RetireFactsInput {
  agentId: string;
  /** The fact that replaces them; recorded as each one's provenance. */
  replacementId: string;
  ids: string[];
}

/**
 * The reads and writes one supersession check performs. `retire` is expected
 * to leave an already-superseded fact alone, so a concurrent write cannot
 * overwrite the first replacement's provenance.
 */
export interface MemorySupersedeRepository {
  readonly kind: 'memory-supersede-repository';
  /** The just-written fact, or null when it is not this agent's. */
  writtenFact(input: { agentId: string; id: string }): Promise<WrittenFact | null>;
  /** Live, unquarantined knowledge facts about the same subject, nearest first. */
  candidates(
    input: SupersedeCandidatesInput,
  ): Promise<Array<SupersedeFact & { similarity: number }>>;
  /** Expire each fact and record what replaced it. Returns the ids actually retired. */
  retire(input: RetireFactsInput): Promise<string[]>;
}
