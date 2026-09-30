import { decideRepairIssue, listRepairIssues, reportRepair } from '@assistant/application';
import { loadConfig } from '@assistant/config';
import { getSelfRepairService } from './server';
export async function getSelfRepairOverview() {
  const { repository, agentId } = await getSelfRepairService();
  const config = loadConfig();
  return {
    enabled: config.SELF_REPAIR_ENABLED,
    configured: Boolean(config.GITHUB_REPO && config.GITHUB_TOKEN),
    dailyLimit: config.SELF_REPAIR_DAILY_LIMIT,
    issues: await listRepairIssues(repository, agentId),
  };
}
export async function decideOwnerRepair(id: string, action: 'dismiss' | 'retry' | 'resolve') {
  const { repository, agentId } = await getSelfRepairService();
  return decideRepairIssue(repository, agentId, id, action);
}
export async function reportOwnerRepair(title: string, summary: string, sourceTaskId?: string) {
  const { repository, agentId } = await getSelfRepairService();
  return reportRepair(repository, agentId, {
    source: 'feedback',
    key: sourceTaskId ?? crypto.randomUUID(),
    title,
    summary,
    sourceTaskId,
  });
}
