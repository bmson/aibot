import type {
  AppendMessageInput,
  ApprovalNoticeGroup,
  ApprovalRepository,
  ApprovalResolution,
  ApprovalWake,
  CreatedApproval,
  MessageRepository,
  Records,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { renotifyStalledApprovals } from './approvals.js';

type NotifyApproval = NonNullable<Parameters<typeof renotifyStalledApprovals>[1]>;

function task(conversationId: string | null): Records['tasks'] {
  return {
    id: 'task-1',
    conversationId,
    status: 'waiting_approval',
    agentId: 'agent-1',
  } as Records['tasks'];
}

function notice(
  id: string,
  taskId: string,
  notifiedChannels: string[] = [],
): Records['approvals'] & { toolName: string } {
  return {
    id,
    taskId,
    status: 'pending',
    shortCode: `A-${id}`,
    summary: `Approve ${id}`,
    notifiedChannels,
    toolName: 'test.outbound',
  } as Records['approvals'] & { toolName: string };
}

function portableFixture(groups: ApprovalNoticeGroup[], appendError?: Error) {
  const storedChannels = new Map(
    groups.flatMap((group) =>
      group.notices.map((approval) => [approval.id, [...approval.notifiedChannels]] as const),
    ),
  );
  const events: string[] = [];
  const listStalledNotices = vi.fn(async () => {
    events.push('list:done');
    return groups;
  });
  const markNotified = vi.fn(async (approvalIds: string[], channels: string[]) => {
    events.push(`mark:${approvalIds.join(',')}:${channels.join(',')}`);
    for (const approvalId of approvalIds) {
      const merged = new Set(storedChannels.get(approvalId) ?? []);
      for (const channel of channels) merged.add(channel);
      storedChannels.set(approvalId, [...merged]);
    }
  });
  const append = vi.fn(async (_input: AppendMessageInput) => {
    events.push('append');
    if (appendError) throw appendError;
    return undefined;
  });
  const repo: ApprovalRepository = {
    kind: 'approval-repository',
    create: async (): Promise<CreatedApproval> => {
      throw new Error('unused');
    },
    getRememberable: async () => null,
    listInbox: async () => ({ pending: [], resolved: [] }),
    listStalledNotices,
    markNotified,
    resolve: async (): Promise<ApprovalResolution> => {
      throw new Error('unused');
    },
    expireStale: async (): Promise<ApprovalWake[]> => [],
    resumeResolved: async (): Promise<ApprovalWake[]> => [],
  };
  const messages: MessageRepository = {
    kind: 'message-repository',
    append,
  };
  return {
    store: { approvals: repo, messages },
    append,
    events,
    listStalledNotices,
    markNotified,
    storedChannels,
  };
}

describe('portable approval notice recovery', () => {
  it('notifies only approvals missing the owner leg and merges both delivered legs', async () => {
    const currentTask = task('conversation-1');
    const ownerAlreadySent = notice('approval-owner-sent', currentTask.id, ['owner']);
    const ownerMissing = notice('approval-owner-missing', currentTask.id);
    const fixture = portableFixture([
      { task: currentTask, notices: [ownerAlreadySent, ownerMissing] },
    ]);
    const notified: string[] = [];
    const notifyApproval = vi.fn<NotifyApproval>(async (_task, notices) => {
      fixture.events.push('owner');
      notified.push(...notices.map((approval) => approval.shortCode));
    });

    await expect(renotifyStalledApprovals(fixture.store, notifyApproval)).resolves.toBe(2);

    expect(notified).toEqual([ownerMissing.shortCode]);
    expect(fixture.append).toHaveBeenCalledOnce();
    expect(fixture.storedChannels.get(ownerAlreadySent.id)).toEqual(['owner', 'conversation']);
    expect(fixture.storedChannels.get(ownerMissing.id)).toEqual(['owner', 'conversation']);
    expect(fixture.events.indexOf('owner')).toBeLessThan(fixture.events.indexOf('append'));
    expect(fixture.listStalledNotices).toHaveBeenCalledWith({});
  });

  it('persists a successful owner leg before a conversation append failure', async () => {
    const currentTask = task('conversation-2');
    const pending = notice('approval-append-fails', currentTask.id);
    const fixture = portableFixture(
      [{ task: currentTask, notices: [pending] }],
      new Error('message store unavailable'),
    );
    const notifyApproval = vi.fn<NotifyApproval>(async () => {
      fixture.events.push('owner');
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(renotifyStalledApprovals(fixture.store, notifyApproval)).resolves.toBe(0);
    } finally {
      errorSpy.mockRestore();
    }

    expect(fixture.storedChannels.get(pending.id)).toEqual(['owner']);
    expect(fixture.events.indexOf('owner')).toBeLessThan(
      fixture.events.findIndex((event) => event.startsWith('mark:')),
    );
    expect(fixture.append).toHaveBeenCalledOnce();
  });

  it('settles the conversation leg without appending when no conversation is owed', async () => {
    const currentTask = task(null);
    const pending = notice('approval-no-conversation', currentTask.id);
    const fixture = portableFixture([{ task: currentTask, notices: [pending] }]);
    const notifyApproval = vi.fn<NotifyApproval>(async () => {
      fixture.events.push('owner');
    });

    await expect(renotifyStalledApprovals(fixture.store, notifyApproval)).resolves.toBe(1);

    expect(fixture.append).not.toHaveBeenCalled();
    expect(fixture.storedChannels.get(pending.id)).toEqual(['owner', 'conversation']);
    expect(fixture.markNotified.mock.calls).toEqual([
      [[pending.id], ['owner']],
      [[pending.id], ['conversation']],
    ]);
  });

  it('runs callbacks after repository reads settle, outside repository operations', async () => {
    const currentTask = task('conversation-3');
    const pending = notice('approval-structural', currentTask.id);
    const fixture = portableFixture([{ task: currentTask, notices: [pending] }]);
    let listSettled = false;
    fixture.listStalledNotices.mockImplementation(async () => {
      await Promise.resolve();
      listSettled = true;
      return [{ task: currentTask, notices: [pending] }];
    });
    const notifyApproval = vi.fn<NotifyApproval>(async () => {
      expect(listSettled).toBe(true);
    });

    await renotifyStalledApprovals(fixture.store, notifyApproval);

    expect(notifyApproval).toHaveBeenCalledOnce();
    expect(fixture.append).toHaveBeenCalledOnce();
  });
});
