/** Data needed to render the mobile workspace's open improvement proposals. */
export interface WorkspaceImprovementRecord {
  id: string;
  kind: 'model_role' | 'policy' | 'prompt' | 'note';
  title: string;
  rationale: string;
  change: Record<string, unknown>;
  evidenceIds: string[];
  createdAt: Date;
}

export interface WorkspaceImprovementRepository {
  readonly kind: 'workspace-improvement-repository';
  /** Matches the PostgreSQL dashboard's newest 100 open proposals. */
  listOpen(agentId: string): Promise<WorkspaceImprovementRecord[]>;
}
