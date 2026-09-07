import type { KnowledgeMapSnapshot } from '@assistant/application';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/profile/knowledge/source-impact-forget', () => ({
  SourceImpactForget: () => <button type="button">Forget source</button>,
}));

import { GlobalKnowledgeMap } from './global-map';

const snapshot: KnowledgeMapSnapshot = {
  nodes: [
    { id: 'parent', label: 'Alex', kind: 'person', component: 0, degree: 2 },
    { id: 'child', label: 'Robin', kind: 'person', component: 0, degree: 2 },
  ],
  edges: ['first', 'second'].map((id) => ({
    id,
    subjectId: 'parent',
    objectId: 'child',
    predicate: 'parent_of',
    reviewStatus: 'unreviewed',
    sourceMemoryId: id,
    sourceContent: 'Family source note.',
    evidenceQuote: 'Alex is Robin’s parent.',
    validFrom: null,
    validUntil: null,
    presentation: {
      sentence: 'Alex is Robin’s parent.',
      label: 'Parent',
      accessibleLabel: 'Alex is Robin’s parent.',
    },
  })),
  components: [{ id: 0, nodes: 2, edges: 2, label: 'Alex' }],
  totalEdges: 2,
  truncated: false,
  filters: { query: '', kind: '', predicates: [], review: 'all', sourceMemoryId: '' },
};

describe('knowledge map inspector', () => {
  it('opens the requested endpoint and retains the incoming fact direction', () => {
    const html = renderToStaticMarkup(
      <GlobalKnowledgeMap snapshot={snapshot} initialSelectedId="child" />,
    );
    expect(html).toContain('Review or edit Robin');
    expect(html).toContain('Alex is Robin’s parent.');
    expect(html).not.toContain('parent of Alex');
    expect(html).toContain('Explore Alex');
    expect(html).toContain('entity=child#knowledge-item');
  });

  it('groups evidence without presenting inferred facts as confirmed', () => {
    const html = renderToStaticMarkup(<GlobalKnowledgeMap snapshot={snapshot} />);
    expect(html).toContain('1 connection in this view');
    expect(html).toContain('Supporting evidence (2)');
    expect(html).toContain('Needs your review');
    expect(html).toContain('stroke-dasharray="5 4"');
    expect(html).toContain('Full source note');
  });

  it('offers an accessible item browser and a safe fallback for absent selection', () => {
    const html = renderToStaticMarkup(
      <GlobalKnowledgeMap snapshot={snapshot} initialSelectedId="missing" />,
    );
    expect(html).toContain('Find an item in this view');
    expect(html).toContain('aria-label="Knowledge items"');
    expect(html).toContain('Review or edit Alex');
  });
});
