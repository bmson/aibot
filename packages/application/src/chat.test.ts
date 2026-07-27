import type { Db } from '@assistant/db';
import type { UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { hydrateChatApprovals } from './chat.js';

describe('hydrateChatApprovals', () => {
  it('hydrates custom approval parts with one batched query', async () => {
    const where = vi.fn().mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        status: 'approved',
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
        payload: { to: ['owner@example.com'], subject: 'Trip details' },
      },
    ]);
    const from = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => ({ from })) } as unknown as Db;
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
        ] as unknown as UIMessage['parts'],
      },
    ] satisfies UIMessage[];

    const hydrated = await hydrateChatApprovals(db, messages);

    expect(hydrated[0]?.parts).toMatchObject([
      { type: 'text' },
      {
        type: 'approval',
        status: 'approved',
        details: [
          { label: 'To', value: 'owner@example.com' },
          { label: 'Subject', value: 'Trip details' },
        ],
      },
    ]);
  });

  it('does not query when no message has actionable parts', async () => {
    const select = vi.fn();
    const db = { select } as unknown as Db;
    const messages = [
      { id: 'message-1', role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] },
    ] satisfies UIMessage[];
    await expect(hydrateChatApprovals(db, messages)).resolves.toBe(messages);
    expect(select).not.toHaveBeenCalled();
  });

  it('renders a stale pending approval as expired', async () => {
    const where = vi.fn().mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        status: 'pending',
        expiresAt: new Date('2026-07-22T17:59:59.000Z'),
        payload: {},
      },
    ]);
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })),
    } as unknown as Db;
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
    const hydrated = await hydrateChatApprovals(db, messages, new Date('2026-07-22T18:00:00.000Z'));
    expect(hydrated[0]?.parts).toMatchObject([{ type: 'approval', status: 'expired' }]);
  });

  it('hydrates a budget request from the current task cap', async () => {
    const where = vi.fn().mockResolvedValue([
      {
        id: '33333333-3333-4333-8333-333333333333',
        status: 'pending',
        budgetUsdLimit: '0.5000',
      },
    ]);
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })),
    } as unknown as Db;
    const messages = [
      {
        id: 'message-1',
        role: 'assistant',
        parts: [
          {
            type: 'budget-request',
            taskId: '33333333-3333-4333-8333-333333333333',
            proposedBudgetUsd: 0.5,
          },
        ] as unknown as UIMessage['parts'],
      },
    ] satisfies UIMessage[];
    const hydrated = await hydrateChatApprovals(db, messages);
    expect(hydrated[0]?.parts).toMatchObject([{ type: 'budget-request', status: 'approved' }]);
  });
});
