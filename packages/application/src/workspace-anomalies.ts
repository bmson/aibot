import type { WorkspaceAnomalyRepository } from '@assistant/persistence';

/** The anomaly item already returned by GET /api/mobile/v1/workspace. */
export interface MobileWorkspaceAnomaly {
  id: string;
  kind: string;
  toolName: string;
  detail: string;
  observed: number;
  expected: number;
  citationCount: number;
  hasPolicy: boolean;
  createdAt: string;
}

export async function listMobileWorkspaceAnomalies(
  repository: WorkspaceAnomalyRepository,
  agentId: string,
): Promise<MobileWorkspaceAnomaly[]> {
  const anomalies = await repository.listOpen(agentId);
  return anomalies.map((anomaly) => ({
    id: anomaly.id,
    kind: anomaly.kind,
    toolName: anomaly.toolName,
    detail: anomaly.detail,
    observed: anomaly.observed,
    expected: anomaly.expected,
    citationCount: anomaly.toolCallIds.length,
    hasPolicy: anomaly.policyId !== null,
    createdAt: anomaly.createdAt.toISOString(),
  }));
}
