import type { ApprovalRepository } from '@assistant/core/workflow/approvals';
import { describe, expect, it, vi } from 'vitest';
import { approveAndRememberApproval } from './approvals.js';

function repository(rememberable: Awaited<ReturnType<ApprovalRepository['getRememberable']>>): {
  repo: ApprovalRepository;
  getRememberable: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
} {
  const getRememberable = vi.fn(async () => rememberable);
  const resolve = vi.fn(async () => ({
    ok: true as const,
    taskId: 'task-1',
    toolCallId: 'tool-1',
    approvalId: 'approval-1',
  }));
  const unusedCreated: Awaited<ReturnType<ApprovalRepository['create']>> = {
    toolCallId: 'tool-1',
    approvalId: 'approval-1',
    shortCode: 'A1AB',
    summary: 'unused',
  };
  return {
    repo: {
      kind: 'approval-repository',
      create: async () => unusedCreated,
      getRememberable,
      listInbox: async () => ({ pending: [], resolved: [] }),
      listStalledNotices: async () => [],
      markNotified: async () => {},
      resolve,
      expireStale: async () => [],
      resumeResolved: async () => [],
    },
    getRememberable,
    resolve,
  };
}

type RememberableApproval = NonNullable<Awaited<ReturnType<ApprovalRepository['getRememberable']>>>;

function approval(payload: unknown): RememberableApproval['approval'] {
  return {
    id: 'approval-1',
    taskId: 'task-1',
    toolCallId: 'tool-1',
    shortCode: 'A1AB',
    summary: 'send email',
    payload,
    resolutionPayload: null,
    status: 'pending',
    requestedAt: new Date('2026-09-12T12:00:00.000Z'),
    resolvedAt: null,
    resolvedVia: null,
    expiresAt: new Date('2026-09-13T12:00:00.000Z'),
    notifiedChannels: [],
    createdPolicyId: null,
  };
}

describe('approveAndRememberApproval', () => {
  it('loads owner-scoped current data and resolves with the derived policy', async () => {
    const fixture = repository({
      approval: approval({ to: ['Friend@Example.com'] }),
      toolName: 'gmail.send',
    });

    await expect(
      approveAndRememberApproval({ agentId: 'agent-1', approvals: fixture.repo }, 'approval-1'),
    ).resolves.toMatchObject({ ok: true });

    expect(fixture.getRememberable).toHaveBeenCalledWith('agent-1', 'approval-1');
    expect(fixture.resolve).toHaveBeenCalledWith({
      approvalId: 'approval-1',
      decision: 'approved',
      via: 'web',
      policy: {
        agentId: 'agent-1',
        toolName: 'gmail.send',
        templateKey: 'gmail.send.to_recipient',
        match: { recipient: 'friend@example.com' },
        effect: 'allow',
      },
    });
  });

  it('approves without a policy when the current payload is ambiguous', async () => {
    const fixture = repository({
      approval: approval({ to: ['one@example.com', 'two@example.com'] }),
      toolName: 'gmail.send',
    });

    await expect(
      approveAndRememberApproval({ agentId: 'agent-1', approvals: fixture.repo }, 'approval-1'),
    ).resolves.toMatchObject({ ok: true });
    expect(fixture.resolve).toHaveBeenCalledWith({
      approvalId: 'approval-1',
      decision: 'approved',
      via: 'web',
    });
  });

  it('returns the repository miss without attempting resolution', async () => {
    const fixture = repository(null);

    await expect(
      approveAndRememberApproval({ agentId: 'agent-1', approvals: fixture.repo }, 'approval-1'),
    ).resolves.toEqual({
      ok: false,
      reason: 'no pending approval matched (already resolved or expired?)',
    });
    expect(fixture.resolve).not.toHaveBeenCalled();
  });
});
