import type { UIMessage } from 'ai';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/cards/actions', () => ({ refreshSavedCardInline: vi.fn() }));
vi.mock('@/app/tasks/actions', () => ({ cancelTask: vi.fn(), raiseTaskBudgetAndRetry: vi.fn() }));
vi.mock('@/app/suggestions/actions', () => ({
  decideSuggestionInline: vi.fn(),
  snoozeSuggestionInline: vi.fn(),
}));
vi.mock('@/app/approvals/actions', () => ({ resolveApprovalInline: vi.fn() }));
vi.mock('../actions', () => ({ recordRecallFeedbackAction: vi.fn() }));

import { ChatLog } from './chat-log';

const messages = [
  {
    id: 'assistant-1',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Here is context for the request.' },
      { type: 'recall', sources: [{ date: '2026-09-01', label: 'Earlier discussion' }] },
      {
        type: 'approval',
        approvalId: 'approval-1',
        shortCode: 'AB12',
        summary: 'Send the invoice',
        status: 'pending',
      },
      {
        type: 'budget-request',
        taskId: 'task-1',
        currentBudgetUsd: 2,
        proposedBudgetUsd: 5,
        spentUsd: 2,
        status: 'pending',
      },
      {
        type: 'suggestion',
        suggestionId: 'suggestion-1',
        summary: 'Review the plan?',
        proposedAction: 'Review the plan',
        status: 'pending',
      },
    ],
    metadata: { createdAt: '2026-09-22T12:00:00.000Z' },
  },
] as unknown as UIMessage[];

function render(legacyActionsAvailable: boolean, log = messages) {
  return renderToStaticMarkup(
    <ChatLog
      log={log}
      legacyActionsAvailable={legacyActionsAvailable}
      busy={false}
      streaming={false}
      notificationMode={false}
      agentTimezone="UTC"
      renderedNow={new Date('2026-09-22T12:01:00.000Z')}
      initialMessageIds={new Set(['assistant-1'])}
      onSend={() => {}}
      onRunForReal={() => {}}
    />,
  );
}

describe('chat transcript in Firestore mode', () => {
  it('shows decision context without SQL-backed controls or recall feedback', () => {
    const html = render(false);
    expect(html).toContain('Decision controls are unavailable in this chat right now.');
    expect(html).toContain('Send the invoice');
    expect(html).toContain('Raise task budget to $5.00');
    expect(html).toContain('Review the plan?');
    expect(html).toContain('Earlier discussion');
    expect(html).not.toContain('Helpful');
    expect(html).not.toContain('Stop task');
    expect(html).not.toContain('Start task');
    expect(html).not.toContain('Review all');
  });

  it('keeps the existing interactive controls in PostgreSQL mode', () => {
    const html = render(true);
    expect(html).toContain('Helpful');
    expect(html).toContain('Stop task');
    expect(html).toContain('Start task');
    expect(html).toContain('Review all');
  });

  it('shows a saved card without offering its SQL-backed refresh action', () => {
    const card = [
      {
        id: 'assistant-card',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Your saved card.' },
          {
            type: 'data-card',
            data: {
              kind: 'generated-card',
              id: 'card-1',
              spec: {
                version: 1,
                title: 'Travel card',
                refreshable: true,
                facts: [{ id: 'hotel', label: 'Hotel', value: 'Grand Hotel', source: 'mail' }],
                blocks: [{ type: 'hero', titleFact: 'hotel' }],
                actions: [],
              },
            },
          },
        ],
      },
    ] as unknown as UIMessage[];
    const portable = render(false, card);
    expect(portable).toContain('Grand Hotel');
    expect(portable).not.toContain('>Refresh</button>');
    expect(render(true, card)).toContain('>Refresh</button>');
  });
});
