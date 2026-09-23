import type {
  ApplicationChatPersistence,
  ShellStatusProjection,
  ShellStatusRepository,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { getPrimaryConversationId, getShellStatus } from './shell.js';

describe('application shell chat bootstrap', () => {
  it('uses the supplied chat persistence without opening PostgreSQL', async () => {
    const persistence = {
      kind: 'application-chat-persistence',
      resolveAgent: vi.fn().mockResolvedValue({ id: 'agent-1' }),
      getOrCreatePrimaryConversation: vi.fn().mockResolvedValue({ id: 'conversation-1' }),
    } as unknown as ApplicationChatPersistence;

    await expect(getPrimaryConversationId(persistence)).resolves.toBe('conversation-1');
    expect(persistence.resolveAgent).toHaveBeenCalledOnce();
    expect(persistence.getOrCreatePrimaryConversation).toHaveBeenCalledWith('agent-1');
  });

  it('loads shell status from the supplied repository without opening PostgreSQL', async () => {
    const projection: ShellStatusProjection = {
      dashboard: { pendingApprovals: 2, needsAttention: 1, presence: 'attention' },
      memoryHealth: {
        totalUsable: 4,
        notYetOrganized: 1,
        awaitingReview: 2,
        ownerConfirmed: 3,
        lastOrganizedAt: new Date('2026-09-22T12:00:00Z'),
      },
    };
    const repository: ShellStatusRepository = {
      kind: 'shell-status-repository',
      load: vi.fn().mockResolvedValue(projection),
    };

    await expect(getShellStatus(repository, 'agent-1')).resolves.toEqual(projection);
    expect(repository.load).toHaveBeenCalledOnce();
    expect(repository.load).toHaveBeenCalledWith('agent-1');
  });
});
