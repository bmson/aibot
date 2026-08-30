import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApprovalSummaryCard } from './approval-summary';

const base = { type: 'approval-summary' as const, purpose: 'Find an open cafe nearby' };

describe('ApprovalSummaryCard', () => {
  it('keeps asking while an approval is still pending', () => {
    const html = renderToStaticMarkup(
      <ApprovalSummaryCard
        summary={{
          ...base,
          approvalCount: 1,
          pendingCount: 1,
          outcomes: [{ id: 'a1', summary: 'Email the cafe', status: 'pending' }],
        }}
      />,
    );
    expect(html).toContain('Approval needed to continue');
    expect(html).toContain('1 action is waiting for review.');
  });

  it('shows the decision once every approval is answered', () => {
    // The bug this covers: the card kept saying "waiting for review" after the
    // owner had already declined on the Approvals page.
    const html = renderToStaticMarkup(
      <ApprovalSummaryCard
        summary={{
          ...base,
          approvalCount: 1,
          pendingCount: 0,
          outcomes: [{ id: 'a1', summary: 'Email the cafe', status: 'denied' }],
        }}
      />,
    );
    expect(html).not.toContain('Approval needed to continue');
    expect(html).not.toContain('waiting for review');
    expect(html).toContain('Declined');
    expect(html).toContain('Email the cafe');
  });

  it('counts down as approvals are answered one at a time', () => {
    const html = renderToStaticMarkup(
      <ApprovalSummaryCard
        summary={{
          ...base,
          approvalCount: 2,
          pendingCount: 1,
          outcomes: [
            { id: 'a1', summary: 'Email the cafe', status: 'approved' },
            { id: 'a2', summary: 'Book a table', status: 'pending' },
          ],
        }}
      />,
    );
    expect(html).toContain('1 action is waiting for review.');
    expect(html).toContain('1 already answered.');
  });

  it('falls back to the frozen count when hydration could not resolve it', () => {
    const html = renderToStaticMarkup(
      <ApprovalSummaryCard summary={{ ...base, approvalCount: 3 }} />,
    );
    expect(html).toContain('3 actions are waiting for review.');
  });
});
