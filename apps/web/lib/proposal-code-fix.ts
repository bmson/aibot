import { reportRepair } from '@assistant/application';
import { getSelfRepairService } from './server';
import { listOpenImprovements } from './workspace-reviews';

export async function requestProposalCodeFix(id: string) {
  const proposal = (await listOpenImprovements()).find((row) => row.id === id);
  if (!proposal) throw new Error('Open proposal not found');
  const { repository, agentId } = await getSelfRepairService();
  return reportRepair(repository, agentId, {
    source: 'proposal',
    key: id,
    proposalId: id,
    title: proposal.title,
    summary: [proposal.rationale, JSON.stringify(proposal.change)].join('\n'),
  });
}
