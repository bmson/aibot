import type { Db, messages as messageTable } from '@assistant/db';
import type { UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { collapseRuntimeMessageDuplicates, hydrateChatApprovals } from './chat.js';

type MessageRow = typeof messageTable.$inferSelect;

function row(id: string, text: string, parts: unknown[], createdAt: string): MessageRow {
  return {
    id,
    conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    taskId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    role: 'assistant',
    parts,
    text,
    origin: 'assistant',
    channelMessageId: null,
    embedding: null,
    createdAt: new Date(createdAt),
  };
}

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

  it('settles an approval summary once the approvals it names are answered', async () => {
    // The summary card has no status of its own, so before this it kept
    // reporting the count frozen in at write time — "1 action is waiting for
    // review" long after the owner had declined it.
    const where = vi.fn().mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        taskId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        summary: 'Email the cafe',
        status: 'denied',
        payload: {},
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      },
    ]);
    const from = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => ({ from })) } as unknown as Db;

    const hydrated = await hydrateChatApprovals(db, [
      {
        id: 'message-1',
        role: 'assistant',
        parts: [
          {
            type: 'approval-summary',
            purpose: 'Find an open cafe nearby',
            approvalCount: 1,
            approvalIds: ['11111111-1111-4111-8111-111111111111'],
          },
        ] as unknown as UIMessage['parts'],
      },
    ] satisfies UIMessage[]);

    expect(hydrated[0]?.parts).toMatchObject([
      {
        type: 'approval-summary',
        pendingCount: 0,
        outcomes: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            summary: 'Email the cafe',
            status: 'denied',
          },
        ],
      },
    ]);
  });

  it('resolves a summary written before it carried ids through its own task', async () => {
    const where = vi.fn().mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        taskId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        summary: 'Email the cafe',
        status: 'pending',
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      },
    ]);
    const from = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => ({ from })) } as unknown as Db;

    const hydrated = await hydrateChatApprovals(db, [
      {
        id: 'message-1',
        role: 'assistant',
        metadata: {
          createdAt: '2026-08-26T08:00:00.000Z',
          taskId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
        parts: [
          { type: 'approval-summary', purpose: 'Find an open cafe nearby', approvalCount: 1 },
        ] as unknown as UIMessage['parts'],
      },
    ] as unknown as UIMessage[]);

    expect(hydrated[0]?.parts).toMatchObject([{ type: 'approval-summary', pendingCount: 1 }]);
  });

  it('leaves a summary alone when there is nothing to resolve it against', async () => {
    const db = { select: vi.fn() } as unknown as Db;
    const parts = [
      { type: 'approval-summary', purpose: 'Find an open cafe nearby', approvalCount: 2 },
    ] as unknown as UIMessage['parts'];

    const hydrated = await hydrateChatApprovals(db, [
      { id: 'message-1', role: 'assistant', parts } satisfies UIMessage,
    ]);

    expect(hydrated[0]?.parts).toEqual(parts);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('collapseRuntimeMessageDuplicates', () => {
  it('keeps only the newest structured approval summary when a dashboard notification retries', () => {
    const first = row(
      '11111111-1111-4111-8111-111111111111',
      'Approval needed to continue: Find an open cafe nearby\n2 actions are waiting for review in Approvals.',
      [
        { type: 'text', text: 'Approval needed to continue: Find an open cafe nearby' },
        { type: 'approval-summary', purpose: 'Find an open cafe nearby', approvalCount: 2 },
      ],
      '2026-08-26T08:00:00.000Z',
    );
    const retry = row(
      '22222222-2222-4222-8222-222222222222',
      'Approval needed to continue: Find an open cafe nearby\n2 actions are waiting for review in Approvals.',
      [
        { type: 'text', text: 'Approval needed to continue: Find an open cafe nearby' },
        { type: 'approval-summary', purpose: 'Find an open cafe nearby', approvalCount: 2 },
      ],
      '2026-08-26T08:00:00.010Z',
    );

    expect(collapseRuntimeMessageDuplicates([first, retry]).map((message) => message.id)).toEqual([
      retry.id,
    ]);
  });

  it('drops the dashboard approval nudge when the same task has its real card', () => {
    const card = row(
      '11111111-1111-4111-8111-111111111111',
      'This needs your approval before I act: A7',
      [
        { type: 'text', text: 'This needs your approval before I act: A7' },
        { type: 'approval', approvalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      ],
      '2026-08-26T08:00:00.000Z',
    );
    const nudge = row(
      '22222222-2222-4222-8222-222222222222',
      'Something needs your approval:\nA7: Search the web',
      [{ type: 'text', text: 'Something needs your approval:\nA7: Search the web' }],
      '2026-08-26T08:00:00.010Z',
    );

    expect(collapseRuntimeMessageDuplicates([card, nudge]).map((message) => message.id)).toEqual([
      card.id,
    ]);
  });

  it('keeps one structured, current needs-attention state for a task', () => {
    const first = row(
      '33333333-3333-4333-8333-333333333333',
      "I couldn't complete this after repeated attempts and stopped. Last error: 2302 tokens",
      [
        {
          type: 'text',
          text: "I couldn't complete this after repeated attempts and stopped. Last error: 2302 tokens",
        },
        { type: 'notice', notice: 'needs-attention' },
      ],
      '2026-08-26T08:01:00.000Z',
    );
    const mirror = row(
      '44444444-4444-4444-8444-444444444444',
      first.text,
      [{ type: 'text', text: first.text }],
      '2026-08-26T08:01:00.010Z',
    );
    const latest = row(
      '55555555-5555-4555-8555-555555555555',
      "I couldn't complete this after repeated attempts and stopped. Last error: 2277 tokens",
      [
        {
          type: 'text',
          text: "I couldn't complete this after repeated attempts and stopped. Last error: 2277 tokens",
        },
        { type: 'notice', notice: 'needs-attention' },
      ],
      '2026-08-26T09:00:00.000Z',
    );

    expect(
      collapseRuntimeMessageDuplicates([first, mirror, latest]).map((message) => message.id),
    ).toEqual([latest.id]);
  });

  it('does not collapse ordinary repeated conversation', () => {
    const first = row(
      '66666666-6666-4666-8666-666666666666',
      'Still here.',
      [{ type: 'text', text: 'Still here.' }],
      '2026-08-26T08:00:00.000Z',
    );
    const second = row(
      '77777777-7777-4777-8777-777777777777',
      'Still here.',
      [{ type: 'text', text: 'Still here.' }],
      '2026-08-26T08:01:00.000Z',
    );

    expect(collapseRuntimeMessageDuplicates([first, second])).toHaveLength(2);
  });
});
