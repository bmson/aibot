import type { Db, TaskRow } from '@assistant/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listMessages } = vi.hoisted(() => ({ listMessages: vi.fn() }));

vi.mock('../../chat.js', () => ({ listMessages }));

import { seedContext } from './seed.js';

function task(input: {
  type: string;
  goalId: string | null;
  instruction?: string;
  text?: string;
}): TaskRow {
  return {
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
    listMessages.mockReset();
  });

  it('appends the generated goal instruction after existing work-chat history', async () => {
    listMessages.mockResolvedValue([
      { role: 'assistant', text: 'Automatic goal work is enabled.' },
      { role: 'user', text: 'Keep searching.' },
    ]);
    const goalId = '00000000-0000-4000-8000-000000000002';
    const instruction = `Run the next session. Goal ID: ${goalId}.`;

    const seeded = await seedContext({} as Db, task({ type: 'scheduled', goalId, instruction }));

    expect(seeded).toEqual([
      { role: 'assistant', content: 'Automatic goal work is enabled.' },
      { role: 'user', content: 'Keep searching.' },
      { role: 'user', content: instruction },
    ]);
  });

  it('does not duplicate an attended goal-chat message already in the conversation', async () => {
    listMessages.mockResolvedValue([{ role: 'user', text: 'Keep searching.' }]);

    const seeded = await seedContext(
      {} as Db,
      task({
        type: 'chat_turn',
        goalId: '00000000-0000-4000-8000-000000000003',
        text: 'Keep searching.',
      }),
    );

    expect(seeded).toEqual([{ role: 'user', content: 'Keep searching.' }]);
  });
});
