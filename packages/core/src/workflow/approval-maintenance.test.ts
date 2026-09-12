import type { ApprovalRepository, ApprovalResolution, ApprovalWake } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { expireStaleApprovals, resumeResolvedApprovalTasks } from './approvals.js';

const notify = vi.fn();

vi.mock('../queue.js', () => ({
  getQueueNotifier: () => ({ notify }),
}));

function repository(wakes: ApprovalWake[]): {
  repo: ApprovalRepository;
  expireStale: ReturnType<typeof vi.fn>;
  resumeResolved: ReturnType<typeof vi.fn>;
} {
  const expireStale = vi.fn(async () => wakes);
  const resumeResolved = vi.fn(async () => wakes);
  const unusedResolve = async (): Promise<ApprovalResolution> => {
    throw new Error('legacy approval resolution path must not be called');
  };
  return {
    repo: {
      kind: 'approval-repository',
      create: async () => {
        throw new Error('unused');
      },
      listInbox: async () => ({ pending: [], resolved: [] }),
      listStalledNotices: async () => [],
      markNotified: async () => {},
      resolve: unusedResolve,
      expireStale,
      resumeResolved,
    },
    expireStale,
    resumeResolved,
  };
}

describe('approval maintenance repository wrappers', () => {
  it('forwards the default bounded expiry batch and returns wake task IDs', async () => {
    notify.mockClear();
    const wakes = [
      { taskId: 'expired-task-a', generation: 4 },
      { taskId: 'expired-task-b', generation: 9 },
    ];
    const fixture = repository(wakes);
    const now = new Date('2026-09-12T15:00:00.000Z');

    await expect(expireStaleApprovals(fixture.repo, undefined, now)).resolves.toEqual([
      'expired-task-a',
      'expired-task-b',
    ]);
    expect(fixture.expireStale).toHaveBeenCalledWith(200, now);
    expect(notify).not.toHaveBeenCalled();
  });

  it('forwards an explicit batch and now to recovery without legacy queue notification', async () => {
    notify.mockClear();
    const wakes = [{ taskId: 'stranded-task', generation: 12 }];
    const fixture = repository(wakes);
    const now = new Date('2026-09-12T16:00:00.000Z');

    await expect(resumeResolvedApprovalTasks(fixture.repo, 37, now)).resolves.toEqual([
      'stranded-task',
    ]);
    expect(fixture.resumeResolved).toHaveBeenCalledWith(37, now);
    expect(notify).not.toHaveBeenCalled();
  });
});
