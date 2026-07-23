import type { ApprovalRow } from '@assistant/db';
import { describe, expect, it } from 'vitest';
import { toPendingApprovalView } from './views';

const now = new Date('2026-07-22T18:00:00.000Z');

function approval(expiresAt: Date): ApprovalRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    taskId: '22222222-2222-4222-8222-222222222222',
    toolCallId: '33333333-3333-4333-8333-333333333333',
    shortCode: 'A1',
    summary: 'Send the project update',
    payload: { to: ['owner@example.com'], subject: 'Update', body: 'Ready to send.' },
    resolutionPayload: null,
    status: 'pending',
    requestedAt: new Date('2026-07-22T17:00:00.000Z'),
    expiresAt,
    resolvedAt: null,
    resolvedVia: null,
    notifiedChannels: [],
    createdPolicyId: null,
  };
}

describe('toPendingApprovalView', () => {
  it('treats pending approvals past their expiry as expired', () => {
    const view = toPendingApprovalView(
      approval(new Date('2026-07-22T17:59:59.000Z')),
      { type: 'chat_turn', trust: 'owner' },
      { toolName: 'gmail.send', decision: null },
      now,
      'UTC',
    );

    expect(view.expired).toBe(true);
    expect(view.actionKind).toBe('email');
  });

  it('keeps future approvals actionable', () => {
    const view = toPendingApprovalView(
      approval(new Date('2026-07-22T18:00:01.000Z')),
      { type: 'chat_turn', trust: 'owner' },
      { toolName: 'calendar.create_event', decision: null },
      now,
      'UTC',
    );

    expect(view.expired).toBe(false);
    expect(view.actionKind).toBe('calendar');
  });
});
