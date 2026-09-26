/** The week's reliability, response-quality and graph health signals for one owner. */
export interface SelfImproveSignals {
  /** Failed tool calls of the owner's tasks. */
  failedCalls: Array<{ toolName: string; error: string | null }>;
  /** The owner's tasks that needed attention or failed after at least two attempts. */
  stuckCount: number;
  /** The owner's most expensive model calls at or above the outlier cost, costliest first. */
  costOutliers: Array<{ role: string; costUsd: string }>;
  contractBlocks: number;
  unsupportedClaims: number;
  mustActRetries: number;
  degradedSteps: number;
  verificationUnavailable: number;
  graphFailedSources: number;
  /** Graph sources still pending since before the stale cutoff. */
  graphStalePending: number;
}

export interface NewImprovementProposal {
  kind: string;
  title: string;
  rationale: string;
  change: Record<string, unknown>;
  evidenceIds: string[];
}

/**
 * The `self.improve` job's reads and proposal ledger. The experience memory is
 * saved through `memoryExtraction.applyMemories`; analysis stays in core.
 */
export interface SelfImprovementRepository {
  readonly kind: 'self-improvement-repository';
  signals(input: {
    agentId: string;
    since: Date;
    staleBefore: Date;
    costOutlierUsd: number;
    outlierLimit: number;
  }): Promise<SelfImproveSignals>;
  /** Record the proposal unless one with the same kind and title exists; true when new. */
  insertProposal(agentId: string, proposal: NewImprovementProposal): Promise<boolean>;
}
