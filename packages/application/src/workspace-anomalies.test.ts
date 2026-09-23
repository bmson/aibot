import type { WorkspaceAnomalyRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { listMobileWorkspaceAnomalies } from './workspace-anomalies.js';

describe('mobile workspace anomaly projection', () => {
  it('uses the selected owner and exactly the existing mobile response fields', async () => {
    const listOpen = vi.fn<WorkspaceAnomalyRepository['listOpen']>().mockResolvedValue([
      {
        id: 'anomaly-one',
        kind: 'burst',
        toolName: 'email.send',
        detail: 'More sends than expected',
        observed: 12,
        expected: 4,
        toolCallIds: ['call-1', 'call-2'],
        policyId: 'policy-one',
        createdAt: new Date('2026-09-22T12:00:00.000Z'),
      },
    ]);
    const repository: WorkspaceAnomalyRepository = {
      kind: 'workspace-anomaly-repository',
      listOpen,
    };

    expect(await listMobileWorkspaceAnomalies(repository, 'owner-one')).toEqual([
      {
        id: 'anomaly-one',
        kind: 'burst',
        toolName: 'email.send',
        detail: 'More sends than expected',
        observed: 12,
        expected: 4,
        citationCount: 2,
        hasPolicy: true,
        createdAt: '2026-09-22T12:00:00.000Z',
      },
    ]);
    expect(listOpen).toHaveBeenCalledExactlyOnceWith('owner-one');
  });
});
