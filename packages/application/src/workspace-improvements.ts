import type { WorkspaceImprovementRepository } from '@assistant/persistence';

/** The improvement item already returned by GET /api/mobile/v1/workspace. */
export interface MobileWorkspaceImprovement {
  id: string;
  kind: string;
  title: string;
  rationale: string;
  suggestion: string;
  evidenceCount: number;
  applyable: boolean;
  createdAt: string;
}

export async function listMobileWorkspaceImprovements(
  repository: WorkspaceImprovementRepository,
  agentId: string,
): Promise<MobileWorkspaceImprovement[]> {
  const proposals = await repository.listOpen(agentId);
  return proposals.map((proposal) => ({
    id: proposal.id,
    kind: proposal.kind,
    title: proposal.title,
    rationale: proposal.rationale,
    suggestion: typeof proposal.change.suggestion === 'string' ? proposal.change.suggestion : '',
    evidenceCount: proposal.evidenceIds.length,
    applyable: proposal.kind === 'model_role',
    createdAt: proposal.createdAt.toISOString(),
  }));
}
