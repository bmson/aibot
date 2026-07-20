import type { Db } from '@assistant/db';
import type { UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { withApprovalStatuses } from './chat-approval-parts';

describe('withApprovalStatuses', () => {
  it('hydrates custom approval parts with one batched status query', async () => {
    const where = vi
      .fn()
      .mockResolvedValue([{ id: '11111111-1111-4111-8111-111111111111', status: 'approved' }]);
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
      { type: 'approval', status: 'approved' },
      { type: 'approval', status: 'missing' },
    ]);
  });

  it('does not query when a message has no approval parts', async () => {
    const select = vi.fn();
    const db = { select } as unknown as Db;
    const messages = [
      { id: 'message-1', role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] },
    ] satisfies UIMessage[];

    await expect(withApprovalStatuses(db, messages)).resolves.toBe(messages);
    expect(select).not.toHaveBeenCalled();
  });
});
