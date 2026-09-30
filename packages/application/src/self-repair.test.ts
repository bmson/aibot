import type { RepairIssue, SelfRepairRepository } from '@assistant/persistence';
import { expect, it, vi } from 'vitest';
import { decideRepairIssue, projectRepairIssue } from './self-repair.js';

const issue: RepairIssue = {
  id: 'issue',
  agentId: 'owner',
  fingerprint: 'x',
  status: 'monitoring',
  version: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  data: {
    source: 'feedback',
    title: 'Fix',
    summary: 'Issue',
    prUrl: 'javascript:alert(1)',
    runUrl: 'https://other.example/run',
    history: [],
  },
};
it('only confirms deployed fixes and rejects stale/foreign issue decisions', async () => {
  const update = vi.fn(async () => issue);
  const repository = { list: async () => [issue], update } as unknown as SelfRepairRepository;
  await decideRepairIssue(repository, 'owner', 'issue', 'resolve');
  expect(update).toHaveBeenCalledWith(issue, 'resolved', expect.any(Object), expect.any(Date));
  await expect(decideRepairIssue(repository, 'owner', 'other', 'resolve')).rejects.toThrow(
    'not found',
  );
  issue.status = 'pr_open';
  await expect(decideRepairIssue(repository, 'owner', 'issue', 'resolve')).rejects.toThrow(
    'after the fix is deployed',
  );
  await expect(decideRepairIssue(repository, 'owner', 'issue', 'dismiss')).rejects.toThrow(
    'Active work',
  );
  issue.status = 'monitoring';
});
it('does not expose untrusted executable links', () => {
  expect(projectRepairIssue(issue)).toMatchObject({ prUrl: null, runUrl: null });
});
