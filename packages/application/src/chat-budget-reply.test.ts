import { describe, expect, it } from 'vitest';
import { budgetReplyTarget, isApprovalReply } from './chat-budget-reply.js';

describe('budget approval replies', () => {
  const part = { type: 'budget-request', taskId: 'task-1', proposedBudgetUsd: 0.25 };
  it('binds explicit approval to the immediately preceding budget card', () => {
    expect(
      budgetReplyTarget('I approve the budget increase', {
        text: '',
        taskId: 'task-1',
        parts: [part],
      }),
    ).toEqual({ taskId: 'task-1', amount: 0.25 });
  });
  it('supports the exact historical notice', () => {
    expect(
      budgetReplyTarget('Approved', {
        text: "I need your permission to raise this task's spending limit from $0.10 to $0.25 so I can finish.",
        taskId: 'task-1',
        parts: [],
      }),
    ).toEqual({ taskId: 'task-1', amount: 0.25 });
  });
  it.each(
    [
      [],
      [part, { ...part, taskId: 'task-2' }],
      [{ ...part, status: 'approved' }],
      [{ ...part, proposedBudgetUsd: -1 }],
    ].map((parts) => ({ parts })),
  )('rejects missing, ambiguous, or resolved cards', ({ parts }) => {
    expect(budgetReplyTarget('Approved', { text: '', taskId: null, parts })).toBeUndefined();
  });
  it('does not treat unrelated approval prose as a budget increase', () => {
    expect(isApprovalReply('Approved design looks good')).toBe(false);
    expect(budgetReplyTarget('Approved')).toBeUndefined();
  });
});
