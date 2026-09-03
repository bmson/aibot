import type { Db, TaskRow } from '@assistant/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listMessages, backgroundNoticeIds } = vi.hoisted(() => ({
  listMessages: vi.fn(),
  backgroundNoticeIds: vi.fn(),
}));

vi.mock('../../chat.js', () => ({
  listMessages,
  backgroundNoticeIds,
  BACKGROUND_NOTICE_MARKER: '[notice]',
}));

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
    backgroundNoticeIds.mockReset();
    backgroundNoticeIds.mockResolvedValue(new Set<string>());
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

  it('names a delivered notice in the window so the reply cannot restate it', async () => {
    // The primary thread carries the owner's chat AND everything the assistant
    // posted on its own. A fired reminder sitting here looked exactly like the
    // assistant's own last turn, and a question about birthdays came back with
    // the reminder read out after the answer.
    listMessages.mockResolvedValue([
      { id: 'm1', role: 'user', text: "who's birthdays are coming up?" },
      { id: 'm2', role: 'assistant', text: 'Attend Clay technical interview' },
    ]);
    backgroundNoticeIds.mockResolvedValue(new Set(['m2']));

    const seeded = await seedContext({} as Db, task({ type: 'chat_turn', goalId: null }));

    expect(seeded).toEqual([
      { role: 'user', content: "who's birthdays are coming up?" },
      { role: 'assistant', content: '[notice]\nAttend Clay technical interview' },
    ]);
  });

  it('seeds an ordinary scheduled task from its trigger instead of stale chat history', async () => {
    listMessages.mockResolvedValue([
      { role: 'user', text: 'Pull the Carnaval photos' },
      { role: 'assistant', text: 'I will look in Drive.' },
    ]);
    const instruction = 'Reminder for the owner: Get sunglasses from the car and pack them.';

    const seeded = await seedContext(
      {} as Db,
      task({ type: 'scheduled', goalId: null, instruction }),
    );

    expect(seeded).toEqual([{ role: 'user', content: instruction }]);
  });
});
