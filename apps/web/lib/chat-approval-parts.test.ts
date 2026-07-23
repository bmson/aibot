import type { Db } from '@assistant/db';
import type { UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { withApprovalStatuses } from './chat-approval-parts';

describe('withApprovalStatuses', () => {
  it('hydrates custom approval parts with one batched status query', async () => {
    const where = vi.fn().mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        status: 'approved',
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
        payload: {
          to: ['owner@example.com'],
          subject: 'Trip details',
          body: 'The exact message body.',
        },
      },
    ]);
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const db = { select } as unknown as Db;
    const messages = [
      {
        id: 'message-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Please review this.' },
          {
            type: 'approval',
            approvalId: '11111111-1111-4111-8111-111111111111',
            shortCode: 'A1',
            summary: 'Send the email',
          },
          {
            type: 'approval',
            approvalId: '22222222-2222-4222-8222-222222222222',
            shortCode: 'A2',
            summary: 'Send the text',
          },
        ] as unknown as UIMessage['parts'],
      },
    ] satisfies UIMessage[];

    const hydrated = await withApprovalStatuses(db, messages);

    expect(select).toHaveBeenCalledTimes(1);
    expect(hydrated[0]?.parts).toMatchObject([
      { type: 'text', text: 'Please review this.' },
      {
        type: 'approval',
        status: 'approved',
        details: [
          { label: 'To', value: 'owner@example.com' },
          { label: 'Subject', value: 'Trip details' },
          { label: 'Body', value: 'The exact message body.' },
        ],
      },
      { type: 'approval', status: 'missing' },
    ]);
  });

  it('renders a stale pending approval as expired', async () => {
    const where = vi.fn().mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        status: 'pending',
        expiresAt: new Date('2026-07-22T17:59:59.000Z'),
        payload: { to: ['owner@example.com'] },
      },
    ]);
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const db = { select } as unknown as Db;
    const messages = [
      {
        id: 'message-1',
        role: 'assistant',
        parts: [
          {
            type: 'approval',
            approvalId: '11111111-1111-4111-8111-111111111111',
            shortCode: 'A1',
            summary: 'Send the email',
          },
        ] as unknown as UIMessage['parts'],
      },
    ] satisfies UIMessage[];

    const hydrated = await withApprovalStatuses(db, messages, new Date('2026-07-22T18:00:00.000Z'));

    expect(hydrated[0]?.parts).toMatchObject([{ type: 'approval', status: 'expired' }]);
  });

  it('hydrates a budget request from the task cap and status', async () => {
    const where = vi.fn().mockResolvedValue([
      {
        id: '33333333-3333-4333-8333-333333333333',
        status: 'pending',
        budgetUsdLimit: '0.5000',
      },
    ]);
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const db = { select } as unknown as Db;
    const messages = [
      {
        id: 'message-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'May I spend more?' },
          {
            type: 'budget-request',
            taskId: '33333333-3333-4333-8333-333333333333',
            currentBudgetUsd: 0.25,
            proposedBudgetUsd: 0.5,
            spentUsd: 0.1061,
          },
        ] as unknown as UIMessage['parts'],
      },
    ] satisfies UIMessage[];

    const hydrated = await withApprovalStatuses(db, messages);

    expect(select).toHaveBeenCalledTimes(1);
    expect(hydrated[0]?.parts).toMatchObject([
      { type: 'text' },
      { type: 'budget-request', status: 'approved' },
    ]);
  });

  it('does not query when a message has no actionable parts', async () => {
    const select = vi.fn();
    const db = { select } as unknown as Db;
    const messages = [
      { id: 'message-1', role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] },
    ] satisfies UIMessage[];

    await expect(withApprovalStatuses(db, messages)).resolves.toBe(messages);
    expect(select).not.toHaveBeenCalled();
  });
});
