import type { Db } from '@assistant/db';
import type { ApplicationChatPersistence } from '@assistant/persistence';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  listOpenCommitments: vi.fn(),
  renderOpenCommitments: vi.fn(),
  goalIdForConversation: vi.fn(),
  clearGoalBlockedOnOwnerReply: vi.fn(async () => {}),
  createChatTask: vi.fn(async () => ({ id: 'task-1' })),
}));

vi.mock('@assistant/core/memory/commitments', () => ({
  listOpenCommitments: stubs.listOpenCommitments,
  renderOpenCommitments: stubs.renderOpenCommitments,
}));

vi.mock('@assistant/core/workflow/schedules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant/core/workflow/schedules')>()),
  goalIdForConversation: stubs.goalIdForConversation,
  clearGoalBlockedOnOwnerReply: stubs.clearGoalBlockedOnOwnerReply,
}));

vi.mock('@assistant/core/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant/core/chat')>()),
  createChatTask: stubs.createChatTask,
}));

const { chatTurnTask, openLoopContext } = await import('./chat-turn.js');

const db = {} as Db;

beforeEach(() => {
  vi.clearAllMocks();
  stubs.createChatTask.mockResolvedValue({ id: 'task-1' });
  stubs.clearGoalBlockedOnOwnerReply.mockResolvedValue(undefined);
});

describe('open-loop context is best effort', () => {
  it('renders the owner’s unfinished business when the read succeeds', async () => {
    stubs.listOpenCommitments.mockResolvedValue([{ id: 'c1' }]);
    stubs.renderOpenCommitments.mockReturnValue('· call the plumber');

    await expect(openLoopContext(db, 'agent-1', 'what was I doing?')).resolves.toBe(
      '· call the plumber',
    );
    expect(stubs.listOpenCommitments).toHaveBeenCalledWith(db, {
      agentId: 'agent-1',
      query: 'what was I doing?',
      limit: 6,
    });
  });

  it('degrades the prompt instead of failing the turn when the read throws', async () => {
    stubs.listOpenCommitments.mockRejectedValue(new Error('commitments table is on fire'));

    await expect(openLoopContext(db, 'agent-1', 'hello')).resolves.toBeUndefined();
  });

  it('reports nothing rather than an empty block when there is nothing open', async () => {
    stubs.listOpenCommitments.mockResolvedValue([]);
    stubs.renderOpenCommitments.mockReturnValue('');

    await expect(openLoopContext(db, 'agent-1', 'hello')).resolves.toBeUndefined();
  });
});

describe('the turn’s task row', () => {
  it('preserves the goal link through portable persistence and clears it before task creation', async () => {
    const goalId = '11111111-1111-4111-8111-111111111111';
    const order: string[] = [];
    const clear = vi.fn(async () => {
      order.push('clear');
    });
    const create = vi.fn(async () => {
      order.push('create');
      return { id: 'portable-task' };
    });
    const chat = {
      kind: 'application-chat-persistence',
      clearGoalBlockedOnOwnerReply: clear,
      createDirectChatTask: create,
    } as unknown as ApplicationChatPersistence;
    await chatTurnTask(chat, {
      agentId: 'a',
      conversationId: 'c',
      title: 'hi',
      metadata: { goalId },
    });
    expect(order).toEqual(['clear', 'create']);
    expect(clear).toHaveBeenCalledWith('a', goalId);
    expect(create).toHaveBeenCalledWith({ agentId: 'a', conversationId: 'c', goalId, title: 'hi' });
    expect(stubs.createChatTask).not.toHaveBeenCalled();
  });

  it('clears a blocked goal before the task exists, not after', async () => {
    const order: string[] = [];
    stubs.goalIdForConversation.mockResolvedValue('goal-1');
    stubs.clearGoalBlockedOnOwnerReply.mockImplementation(async () => {
      order.push('clear');
    });
    stubs.createChatTask.mockImplementation(async () => {
      order.push('create');
      return { id: 'task-1' };
    });

    await chatTurnTask(db, { agentId: 'a', conversationId: 'c', title: 'hi' });

    expect(order).toEqual(['clear', 'create']);
    expect(stubs.createChatTask).toHaveBeenCalledWith(db, {
      agentId: 'a',
      conversationId: 'c',
      goalId: 'goal-1',
      title: 'hi',
    });
  });

  it('skips the goal bookkeeping for a chat that belongs to no goal', async () => {
    stubs.goalIdForConversation.mockResolvedValue(undefined);

    await chatTurnTask(db, { agentId: 'a', conversationId: 'c', title: 'hi' });

    expect(stubs.clearGoalBlockedOnOwnerReply).not.toHaveBeenCalled();
    expect(stubs.createChatTask).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ goalId: undefined }),
    );
  });

  it('propagates a failure, because a turn with no task row cannot bill its model call', async () => {
    stubs.goalIdForConversation.mockResolvedValue(undefined);
    stubs.createChatTask.mockRejectedValue(new Error('no budget row'));

    await expect(
      chatTurnTask(db, { agentId: 'a', conversationId: 'c', title: 'hi' }),
    ).rejects.toThrow('no budget row');
  });
});
