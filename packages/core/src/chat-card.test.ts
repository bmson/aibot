import { describe, expect, it } from 'vitest';
import { compactChatMessageParts, compactNoticePresentation } from './chat-card.js';

describe('compactNoticePresentation', () => {
  it('does not label blocked or partially completed work as verified', () => {
    expect(
      compactNoticePresentation('response-contract', "I couldn't complete this.").headline,
    ).toBe('Result not confirmed');
    expect(
      compactNoticePresentation('response-contract', 'Completed: one save. Still needed: the rest.')
        .headline,
    ).toBe('Partially completed');
    const parts = compactChatMessageParts('No successful tool result was returned.', [
      {
        type: 'notice',
        notice: 'response-contract',
        presentation: { version: 1, headline: 'Verified result', summary: 'Old copy' },
      },
    ]);
    expect(parts[0]).toMatchObject({ presentation: { headline: 'Result not confirmed' } });
  });
  it('puts the owner question in the first-glance summary', () => {
    expect(
      compactNoticePresentation(
        'needs-attention',
        "This goal's automatic session is blocked until you answer: Before I proceed, I need to know: Remote only or specific cities?",
      ),
    ).toMatchObject({
      version: 1,
      headline: 'Your input is needed',
      summary: 'Remote only or specific cities?',
      detailLabel: 'Technical details',
    });
  });

  it('states self-resuming pauses without exposing budget prose first', () => {
    expect(
      compactNoticePresentation(
        'parked',
        "I'm pausing here — the daily budget is exhausted. This resumes automatically when the budget resets.",
      ),
    ).toMatchObject({
      headline: 'Work paused',
      summary: 'This work will resume automatically when its limit resets.',
    });
  });

  it('removes narrative setup from source-verification summaries', () => {
    expect(
      compactNoticePresentation(
        'needs-attention',
        'Here’s what I found in the connected sources: - Calendar: no successful event read.',
      ),
    ).toMatchObject({
      headline: 'Your input is needed',
      summary: 'Calendar: no successful event read.',
    });
  });
});

describe('compactChatMessageParts', () => {
  it('upgrades a marked notice without changing its text part', () => {
    const text = 'A task stopped and needs you — “Prepare launch brief”. Last error: EACCES.';
    const parts = [
      { type: 'text', text },
      { type: 'notice', notice: 'needs-attention' },
    ];
    expect(compactChatMessageParts(text, parts, 'task-1')).toEqual([
      parts[0],
      expect.objectContaining({
        type: 'notice',
        notice: 'needs-attention',
        taskId: 'task-1',
        presentation: expect.objectContaining({
          headline: 'Prepare launch brief',
          summary: 'This task stopped and needs your direction.',
        }),
      }),
    ]);
  });

  it('recognizes historical blocked-goal prose without rewriting storage', () => {
    const text = 'blocked on owner input: Remote only or specific locations?';
    expect(compactChatMessageParts(text, [{ type: 'text', text }])).toEqual([
      { type: 'text', text },
      expect.objectContaining({
        type: 'notice',
        notice: 'needs-attention',
        presentation: expect.objectContaining({ summary: 'Remote only or specific locations?' }),
      }),
    ]);
  });

  it('does not wrap structured decision or result cards in a second card', () => {
    const decision = [{ type: 'approval', approvalId: 'a1' }];
    const result = [{ type: 'data-card', data: { kind: 'weather' } }];
    expect(compactChatMessageParts('A task stopped and needs you', decision)).toBe(decision);
    expect(compactChatMessageParts('A task stopped and needs you', result)).toBe(result);
  });
});
