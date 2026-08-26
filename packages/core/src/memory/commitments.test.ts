import type { CommitmentRow } from '@assistant/db';
import { describe, expect, it } from 'vitest';
import { renderOpenCommitments } from './commitments.js';

function row(overrides: Partial<CommitmentRow> = {}): CommitmentRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    agentId: '00000000-0000-0000-0000-000000000002',
    conversationId: '00000000-0000-0000-0000-000000000003',
    sourceMessageId: null,
    sourceTaskId: null,
    kind: 'question',
    title: 'Confirm the travel dates',
    details: '',
    nextAction: 'Choose between Thursday and Friday',
    status: 'open',
    dueAt: null,
    snoozedUntil: null,
    resolvedAt: null,
    resolution: null,
    confidence: '0.95',
    contentHash: 'hash',
    createdAt: new Date('2026-08-25T00:00:00Z'),
    updatedAt: new Date('2026-08-25T00:00:00Z'),
    ...overrides,
  };
}

describe('open-loop rendering', () => {
  it('renders a bounded, instruction-free continuity block', () => {
    const rendered = renderOpenCommitments([row({ dueAt: new Date('2026-08-30T00:00:00Z') })]);
    expect(rendered).toContain('Open loops from earlier owner conversations');
    expect(rendered).toContain('[question] Confirm the travel dates');
    expect(rendered).toContain('Next: Choose between Thursday and Friday');
    expect(rendered).toContain('due 2026-08-30');
    expect(rendered.length).toBeLessThanOrEqual(1400);
  });

  it('does not render an empty block', () => {
    expect(renderOpenCommitments([])).toBe('');
  });
});
