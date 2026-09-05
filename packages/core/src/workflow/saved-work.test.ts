import type { Db, TaskRow } from '@assistant/db';
import { describe, expect, it, vi } from 'vitest';
import { enforceResponseContract } from './response-contract.js';
import {
  isDurableSave,
  isMemoryWriteRequest,
  isSaveStatusQuestion,
  previousSaveStatus,
  savedWorkSummary,
  saveStatusResponse,
  stepLimitResponse,
} from './saved-work.js';

const birthday = (person: string) => ({
  toolName: 'occasions.save',
  status: 'succeeded',
  args: { kind: 'birthday' },
  result: { saved: true, person, quarantined: false },
});

describe('saved-work receipts', () => {
  it('counts repeated updates to the same occasion once', () => {
    const item = { ...birthday('A'), args: { kind: 'birthday', month: 1, day: 2 } };
    expect(savedWorkSummary([item, item])).toContain('1 birthday entry');
  });

  it('does not invite retrying a deliberately forgotten fact', () => {
    const result = enforceResponseContract('Saved it to memory.', [
      {
        toolName: 'memory.save',
        status: 'succeeded',
        result: { saved: false, tombstoned: true },
      },
    ]);
    expect(result.text).toContain('previously forgotten');
    expect(result.text).not.toContain('retry');
  });
  it('reports the twelve actual saves when the step budget is exhausted', () => {
    const evidence = Array.from({ length: 12 }, (_, i) => birthday(`Person ${i + 1}`));
    const text = stepLimitResponse(12, evidence);
    expect(text).toContain('12 birthday entries in People');
    expect(text).toContain('Person 12');
    expect(text).toContain('remaining work has not been completed');
    expect(text).not.toContain("didn't get far enough");
  });

  it('rejects quarantined, forgotten, failed, and prior-turn saves', () => {
    for (const item of [
      { ...birthday('A'), status: 'failed' },
      { ...birthday('A'), fromCurrentTask: false },
      { ...birthday('A'), result: { saved: false } },
      { ...birthday('A'), result: { saved: true, quarantined: true } },
      { ...birthday('A'), toolName: 'memory.save', result: { saved: false, tombstoned: true } },
      { ...birthday('A'), toolName: 'memory.save', result: { ok: true } },
    ])
      expect(isDurableSave(item)).toBe(false);
    expect(isDurableSave({ ...birthday('A'), result: { saved: false, updated: true } })).toBe(true);
  });

  it('answers status from receipts without claiming the entire batch or current existence', () => {
    const text = saveStatusResponse([birthday('A')], 'failed');
    expect(text).toContain('Partly.');
    expect(text).toContain('does not confirm the whole list');
    expect(text).toContain('edited or removed');
    expect(saveStatusResponse([], 'done')).toContain('no confirmed memory or occasion save');
  });

  it('recognizes the live typo but never treats a status question as a write', () => {
    for (const text of [
      'Was it save to long term memory',
      'Did you save that?',
      'Has it been saved?',
    ]) {
      expect(isSaveStatusQuestion(text)).toBe(true);
      expect(isMemoryWriteRequest(text)).toBe(false);
    }
    expect(isSaveStatusQuestion('Save this to memory')).toBe(false);
    expect(isMemoryWriteRequest('This is our order for you to remember. Two cheese pupusas.')).toBe(
      true,
    );
    expect(isMemoryWriteRequest("Don't save this to memory")).toBe(false);
  });

  it('does not use an unrelated older successful save for the preceding request', async () => {
    const where = vi.fn().mockResolvedValue([]);
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => [
                  {
                    id: 'status',
                    status: 'done',
                    trigger: { payload: { text: 'Was it save to long term memory' } },
                  },
                  {
                    id: 'recent',
                    status: 'done',
                    trigger: { payload: { text: 'Remember our new order' } },
                  },
                  {
                    id: 'old',
                    status: 'done',
                    trigger: { payload: { text: 'Remember the old order' } },
                  },
                ],
              }),
            }),
          }),
        })
        .mockReturnValueOnce({ from: () => ({ where }) }),
    } as unknown as Db;
    const text = await previousSaveStatus(db, {
      id: 'current',
      agentId: 'agent',
      conversationId: 'chat',
      type: 'chat_turn',
      createdAt: new Date(),
    } as TaskRow);
    expect(text).toContain('no confirmed');
    expect(db.select).toHaveBeenCalledTimes(2);
    expect(where).toHaveBeenCalledTimes(1);
  });

  it('does not accept a tool-less future promise or passive memory badge', () => {
    for (const text of [
      'I’ll remember your order.',
      'Memory saved — the runtime will confirm it.',
    ]) {
      expect(enforceResponseContract(text, []).blocked).toBe(true);
    }
    const question = 'What would you like me to remember?';
    expect(enforceResponseContract(question, [], { requestText: 'Remember our order' }).text).toBe(
      question,
    );
  });

  it('does not mistake a terse done for a successful batch save', () => {
    const requestText = 'Here are birthdays for family members, update their information.';
    for (const text of ['Done!', 'All birthdays are saved.']) {
      expect(enforceResponseContract(text, [], { requestText }).blocked).toBe(true);
      const checked = enforceResponseContract(text, [birthday('A')], { requestText });
      expect(checked.text).toContain('1 birthday entry');
      expect(checked.text).not.toContain('All birthdays are saved');
    }
  });

  it('replaces invented confirmation details with the actual saved content', () => {
    const evidence = [
      {
        toolName: 'memory.save',
        status: 'succeeded',
        args: { content: 'Our order is two cheese pupusas.' },
        result: { saved: true },
      },
    ];
    const result = enforceResponseContract('I saved your order: steak and fries.', evidence, {
      requestText: 'Remember our order',
    });
    expect(result.text).toContain('two cheese pupusas');
    expect(result.text).not.toContain('steak');
    expect(savedWorkSummary([{ ...birthday('A'), fromCurrentTask: false }])).toBeUndefined();
  });
});
