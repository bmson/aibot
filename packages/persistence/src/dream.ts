/** An owner-facing overnight observation, kept for a week of inspection. */
export interface NewDreamNote {
  kind: 'footnote' | 'anticipation';
  content: string;
  expiresAt: Date;
}

/**
 * The `dream.run` job's reads and its note ledger. Hypotheses are saved through
 * `memoryExtraction.applyMemories`, so they share its lease, checkpoint and
 * tombstone handling; composing the dream stays in core.
 */
export interface DreamRepository {
  readonly kind: 'dream-repository';
  /** The owner's tasks that needed attention or failed, updated since `since`. */
  failedTasks(
    agentId: string,
    since: Date,
    limit: number,
  ): Promise<Array<{ type: string; progress: string; status: string }>>;
  /** Failed tool calls of the owner's tasks created since `since`. */
  failedToolCalls(
    agentId: string,
    since: Date,
    limit: number,
  ): Promise<Array<{ toolName: string; error: string | null }>>;
  /** Approved or denied approvals of the owner's tasks requested since `since`, newest first. */
  approvalDecisions(
    agentId: string,
    since: Date,
    limit: number,
  ): Promise<Array<{ summary: string; status: string }>>;
  /** Record the night's notes once per dream task, so a retried run converges. */
  addNotes(agentId: string, taskId: string, notes: NewDreamNote[]): Promise<void>;
}
