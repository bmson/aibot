import type { Db } from '@assistant/db';
import { describe, expect, it } from 'vitest';
import { backgroundNoticeIds } from './chat.js';

/**
 * Both signals matter and neither covers the other: the pulse, suggestions and
 * approval mirrors say what they are in their parts, while a fired reminder
 * writes a bare text part (memory/jobs.ts) and is only separable by the task
 * that produced it.
 */
function dbReturning(rows: Array<{ id: string; type: string }>): Db {
  return {
    select: () => ({ from: () => ({ where: async () => rows }) }),
  } as unknown as Db;
}

const text = (value: string) => [{ type: 'text', text: value }];

describe('backgroundNoticeIds', () => {
  it('marks a proactive-alert card, a suggestion, and a notice part', async () => {
    const rows = [
      {
        id: 'pulse',
        role: 'assistant',
        taskId: null,
        parts: [
          ...text('"Fall Practice" starts in 30 minutes.'),
          { type: 'data-card', data: { kind: 'proactive-alert', id: 'event-lead:1' } },
        ],
      },
      {
        id: 'suggested',
        role: 'assistant',
        taskId: null,
        parts: [...text('Want me to reply?'), { type: 'suggestion', suggestionId: 's1' }],
      },
      {
        id: 'parked',
        role: 'assistant',
        taskId: null,
        parts: [...text('I stopped and need you.'), { type: 'notice', notice: 'needs-attention' }],
      },
    ];
    const found = await backgroundNoticeIds(dbReturning([]), rows);
    expect([...found].sort()).toEqual(['parked', 'pulse', 'suggested']);
  });

  it('marks a bare-text reminder by its owning task type, not its parts', async () => {
    const rows = [
      { id: 'reminder', role: 'assistant', taskId: 'task-scheduled', parts: text('Attend Clay') },
      { id: 'reply', role: 'assistant', taskId: 'task-chat', parts: text('It is hunter2.') },
    ];
    const found = await backgroundNoticeIds(
      dbReturning([
        { id: 'task-scheduled', type: 'scheduled' },
        { id: 'task-chat', type: 'chat_turn' },
      ]),
      rows,
    );
    expect([...found]).toEqual(['reminder']);
  });

  it('never marks the owner, and reads no tasks when nothing is pending', async () => {
    const explode = {
      select: () => {
        throw new Error('should not query tasks');
      },
    } as unknown as Db;
    const found = await backgroundNoticeIds(explode, [
      // An owner turn is never a notice, whatever it carries.
      { id: 'owner', role: 'user', taskId: 'task-scheduled', parts: text('remind me at 9') },
      // An assistant turn with no task and no marker is an ordinary reply.
      { id: 'reply', role: 'assistant', taskId: null, parts: text('Sure.') },
    ]);
    expect(found.size).toBe(0);
  });

  it('does not mark a data-card that is an ordinary answer card', async () => {
    const found = await backgroundNoticeIds(dbReturning([]), [
      {
        id: 'agenda',
        role: 'assistant',
        taskId: null,
        parts: [
          ...text("Here's your day."),
          { type: 'data-card', data: { kind: 'agenda', id: 'agenda-1' } },
        ],
      },
    ]);
    expect(found.size).toBe(0);
  });
});
