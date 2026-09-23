/** Data needed to render the mobile workspace's open approval anomalies. */
export interface WorkspaceAnomalyRecord {
  id: string;
  kind: 'frequency' | 'off_hours' | 'burst';
  toolName: string;
  detail: string;
  observed: number;
  expected: number;
  toolCallIds: string[];
  policyId: string | null;
  createdAt: Date;
}

export interface WorkspaceAnomalyRepository {
  readonly kind: 'workspace-anomaly-repository';
  /** Matches the PostgreSQL dashboard's newest 100 open anomalies. */
  listOpen(agentId: string): Promise<WorkspaceAnomalyRecord[]>;
}
