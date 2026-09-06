import type { SituationPackView } from '@assistant/application/situations';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PacksPanel } from './packs-panel';

const pack: SituationPackView = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Soccer weekend',
  version: 1,
  archived: false,
  updatedAt: '2026-09-06T12:00:00Z',
  changes: [],
  affectedIds: ['ride'],
  data: {
    items: [
      {
        id: 'ride',
        title: 'Confirm the ride',
        details: 'Ask after the hotel reply',
        lane: 'i_owe',
        dependsOn: [],
        source: null,
        snapshot: null,
        needsReview: true,
      },
    ],
    decisions: [
      {
        id: 'dinner',
        option: 'Late dinner',
        outcome: 'rejected',
        reason: 'Too late before the match',
        scope: 'situation',
        confirmed: true,
      },
    ],
  },
};
describe('situation packs presentation', () => {
  it('shows named responsibility lanes and a scoped rejection reason', () => {
    const initial = { packs: [pack], sources: [] };
    const html = renderToStaticMarkup(
      <PacksPanel
        initial={initial}
        change={async () => ({ ok: true, packId: pack.id })}
        reload={async () => initial}
      />,
    );
    for (const text of [
      'Waiting on',
      'I owe',
      'Plan',
      'Passed on',
      'Too late before the match',
      'For this situation only',
      'Needs review',
    ])
      expect(html).toContain(text);
    expect(html).toContain('/chat?ask=');
    expect(html).not.toContain('Confirmed preference');
  });
  it('has a usable empty state and labeled create control', () => {
    const initial = { packs: [], sources: [] };
    const html = renderToStaticMarkup(
      <PacksPanel
        initial={initial}
        change={async () => ({ ok: false, error: 'offline' })}
        reload={async () => initial}
      />,
    );
    expect(html).toContain('Start with one situation');
    expect(html).toContain('aria-label="New pack title"');
    expect(html).toContain('type="submit"');
  });
});
