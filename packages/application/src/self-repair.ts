import {
  ACTIVE_REPAIR_STATUSES,
  queuedRepairIssues,
  type RepairIssue,
  repairDispatchesUsed,
  type SelfRepairRepository,
} from '@assistant/persistence';

export { isRepairFeedback, reportRepair } from '@assistant/core/workflow/self-repair';

function githubLink(value?: string): string | null {
  return value &&
    /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull\/\d+|actions\/runs\/\d+)$/.test(value)
    ? value
    : null;
}
export function projectRepairIssue(issue: RepairIssue) {
  return {
    id: issue.id,
    title: issue.data.title,
    summary: issue.data.summary,
    status: issue.status,
    diagnosis: issue.data.diagnosis ?? '',
    lastError: issue.data.lastError ?? '',
    sourceTaskId: issue.data.sourceTaskId ?? null,
    prUrl: githubLink(issue.data.prUrl),
    runUrl: githubLink(issue.data.runUrl),
    mergeSha: issue.data.mergeSha ?? null,
    history: issue.data.history,
    createdAt: issue.createdAt.toISOString(),
    updatedAt: issue.updatedAt.toISOString(),
  };
}
export async function listRepairIssues(
  repository: SelfRepairRepository,
  agentId: string,
  dailyLimit?: number,
) {
  const rows = await repository.list(agentId);
  const queue = queuedRepairIssues(rows);
  const active = rows.some((row) => ACTIVE_REPAIR_STATUSES.includes(row.status));
  const used = repairDispatchesUsed(rows);
  return rows
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, 100)
    .map((issue) => ({
      ...projectRepairIssue(issue),
      queuePosition:
        issue.status === 'reported' ? queue.findIndex((row) => row.id === issue.id) + 1 : null,
      waitingReason:
        issue.status === 'reported'
          ? active
            ? 'Waiting for the current investigation or PR review to finish.'
            : dailyLimit !== undefined && used >= dailyLimit
              ? `Daily coding allowance used: ${used} of ${dailyLimit} attempts in the last 24 hours. Starts automatically when an allowance is available.`
              : 'Queued for automatic investigation on the next minute check.'
          : null,
    }));
}
export async function decideRepairIssue(
  repository: SelfRepairRepository,
  agentId: string,
  id: string,
  action: 'dismiss' | 'retry' | 'resolve',
) {
  const issue = (await repository.list(agentId)).find((row) => row.id === id);
  if (!issue) throw new Error('Repair issue not found');
  if (
    action === 'dismiss' &&
    ['investigating', 'fixing', 'testing', 'pr_open'].includes(issue.status)
  )
    throw new Error('Active work must finish first. Close an open PR on GitHub to dismiss it.');
  if (action === 'retry' && !['failed', 'blocked'].includes(issue.status))
    throw new Error('Only failed or blocked issues can be retried');
  if (action === 'resolve' && issue.status !== 'monitoring')
    throw new Error('Confirm resolution after the fix is deployed');
  const next = await repository.update(
    issue,
    action === 'retry' ? 'reported' : action === 'resolve' ? 'resolved' : 'dismissed',
    {
      lastError: '',
      ...(action === 'retry'
        ? {
            notifiedStatus: undefined,
            runId: undefined,
            runUrl: undefined,
            diagnosis: undefined,
            category: undefined,
            targetPaths: undefined,
            reproduction: undefined,
            acceptance: undefined,
            branch: undefined,
            dispatchedAt: undefined,
            prNumber: undefined,
            prUrl: undefined,
          }
        : {}),
    },
    new Date(),
  );
  if (!next) throw new Error('Issue changed; refresh and try again');
}
