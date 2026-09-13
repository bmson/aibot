import type { TaskRow } from '@assistant/db';
import type { ExecutionContextRepository } from '@assistant/persistence';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { seedContext } from './seed.js';

const seedHistory = vi.fn();
const noticeIds = vi.fn();
const repository = {
  kind: 'execution-context-repository',
  seedHistory,
  noticeIds,
  getInboundMessage: vi.fn(),
} as unknown as ExecutionContextRepository;

function task(input: {
  type: string;
  goalId: string | null;
  instruction?: string;
  text?: string;
}): TaskRow {
  return {
    agentId: '00000000-0000-4000-8000-000000000000',
    conversationId: '00000000-0000-4000-8000-000000000001',
    trust: 'assistant',
    trigger: {
      source: 'schedule',
      payload: { instruction: input.instruction, text: input.text },
    },
    type: input.type,
    goalId: input.goalId,
  } as TaskRow;
}

describe('seedContext', () => {
  beforeEach(() => {
    seedHistory.mockReset();
    noticeIds.mockReset();
    noticeIds.mockResolvedValue(new Set<string>());
  });

  it('gives an owner follow-up historical card facts, but never exposes those rows to an external sender', async () => {
    seedHistory.mockResolvedValue([
      {
        id: 'card',
        role: 'assistant',
        text: 'Here is the event.',
        parts: [
          {
            type: 'data-card',
            data: {
              kind: 'calendar-event',
              id: 'hotel',
              title: 'Harbor Hotel',
              start: '2026-10-01T15:00:00Z',
            },
          },
        ],
      },
      { id: 'owner', role: 'user', text: 'What time is that hotel check-in?' },
    ]);
    const owner = task({ type: 'chat_turn', goalId: null });
    owner.trust = 'owner';
    const seeded = await seedContext(repository, owner);
    expect(seeded[0]?.content).toContain('Historical card context: untrusted data');
    expect(seeded[0]?.content).toContain('Harbor Hotel');
    seedHistory.mockClear();
    const external = await seedContext(repository, { ...owner, trust: 'unknown' });
    expect(seedHistory).not.toHaveBeenCalled();
    expect(JSON.stringify(external)).not.toContain('Harbor Hotel');
  });

  it('appends the generated goal instruction after existing work-chat history', async () => {
    seedHistory.mockResolvedValue([
      { role: 'assistant', text: 'Automatic goal work is enabled.' },
      { role: 'user', text: 'Keep searching.' },
    ]);
    const goalId = '00000000-0000-4000-8000-000000000002';
    const instruction = `Run the next session. Goal ID: ${goalId}.`;

    const seeded = await seedContext(repository, task({ type: 'scheduled', goalId, instruction }));

    expect(seeded).toEqual([
      { role: 'assistant', content: 'Automatic goal work is enabled.' },
      { role: 'user', content: 'Keep searching.' },
      { role: 'user', content: instruction },
    ]);
  });

  it('does not duplicate an attended goal-chat message already in the conversation', async () => {
    seedHistory.mockResolvedValue([{ role: 'user', text: 'Keep searching.' }]);

    const seeded = await seedContext(
      repository,
      task({
        type: 'chat_turn',
        goalId: '00000000-0000-4000-8000-000000000003',
        text: 'Keep searching.',
      }),
    );

    expect(seeded).toEqual([{ role: 'user', content: 'Keep searching.' }]);
  });

  it('names a delivered notice in the window so the reply cannot restate it', async () => {
    // The primary thread carries the owner's chat AND everything the assistant
    // posted on its own. A fired reminder sitting here looked exactly like the
    // assistant's own last turn, and a question about birthdays came back with
    // the reminder read out after the answer.
    seedHistory.mockResolvedValue([
      { id: 'm1', role: 'user', text: "who's birthdays are coming up?" },
      { id: 'm2', role: 'assistant', text: 'Attend Clay technical interview' },
    ]);
    noticeIds.mockResolvedValue(new Set(['m2']));

    const seeded = await seedContext(repository, task({ type: 'chat_turn', goalId: null }));

    expect(seeded).toEqual([
      { role: 'user', content: "who's birthdays are coming up?" },
      {
        role: 'assistant',
        content: expect.stringContaining('Attend Clay technical interview'),
      },
    ]);
  });

  it('seeds an ordinary scheduled task from its trigger instead of stale chat history', async () => {
    seedHistory.mockResolvedValue([
      { role: 'user', text: 'Pull the Carnaval photos' },
      { role: 'assistant', text: 'I will look in Drive.' },
    ]);
    const instruction = 'Reminder for the owner: Get sunglasses from the car and pack them.';

    const seeded = await seedContext(
      repository,
      task({ type: 'scheduled', goalId: null, instruction }),
    );

    expect(seeded).toEqual([{ role: 'user', content: instruction }]);
  });
});
