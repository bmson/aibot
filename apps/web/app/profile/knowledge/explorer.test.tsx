import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ExplorerEdge } from '@/app/profile/knowledge/explorer-model';

// The server action is never called during a static render, but importing the
// real module would drag the whole server composition root into the test.
vi.mock('@/app/profile/knowledge/actions', () => ({
  loadKnowledgeNeighborhood: vi.fn(async () => ({ edges: [], total: 0 })),
}));

import { KnowledgeGraphExplorer } from '@/app/profile/knowledge/explorer';

const vocabulary = [
  {
    id: 'father_of',
    group: 'family',
    subjectKinds: ['person'],
    objectKinds: ['person'],
  },
  {
    id: 'works_at',
    group: 'work and education',
    subjectKinds: ['person'],
    objectKinds: ['organization'],
  },
] as const;

const selected = { id: 'c', label: 'Brynja', kind: 'person' };

const edges: ExplorerEdge[] = [
  {
    id: 'e1',
    predicate: 'father_of',
    outbound: false,
    reviewStatus: 'confirmed',
    validFrom: null,
    validUntil: null,
    other: { id: 'g', label: 'Gunnar', kind: 'person' },
  },
  {
    id: 'e2',
    predicate: 'works_at',
    outbound: true,
    reviewStatus: 'unreviewed',
    validFrom: '2019',
    validUntil: '2023-03',
    other: { id: 'a', label: 'Acme', kind: 'organization' },
  },
  {
    id: 'e3',
    predicate: 'advises',
    outbound: true,
    reviewStatus: 'confirmed',
    validFrom: null,
    validUntil: null,
    other: { id: 'm', label: 'Mote', kind: 'organization' },
  },
];

describe('KnowledgeGraphExplorer static render', () => {
  it('groups edges by relationship family with Other last', () => {
    const html = renderToStaticMarkup(
      <KnowledgeGraphExplorer
        selected={selected}
        edges={edges}
        total={3}
        vocabulary={vocabulary}
        query=""
        kind=""
        locale="en"
      />,
    );
    expect(html.indexOf('Family')).toBeLessThan(html.indexOf('Work and education'));
    expect(html.indexOf('Work and education')).toBeLessThan(html.indexOf('Other'));
    expect(html).toContain('Gunnar');
    expect(html).toContain('father of');
  });

  it('shows direction, span, and review state on the row', () => {
    const html = renderToStaticMarkup(
      <KnowledgeGraphExplorer
        selected={selected}
        edges={edges}
        total={3}
        vocabulary={vocabulary}
        query=""
        kind=""
        locale="en"
      />,
    );
    expect(html).toContain('2019 to March 2023');
    expect(html).toContain('needs review');
    expect(html).toContain('>incoming</span>');
    expect(html).toContain('>outgoing</span>');
  });

  it('renders an expand toggle per row with an accessible name', () => {
    const html = renderToStaticMarkup(
      <KnowledgeGraphExplorer
        selected={selected}
        edges={edges}
        total={3}
        vocabulary={vocabulary}
        query=""
        kind=""
        locale="en"
      />,
    );
    expect(html).toContain('aria-label="Show connections around Gunnar"');
    expect(html).toContain('aria-expanded="false"');
  });

  it('keeps the current view and filters in entity links', () => {
    const html = renderToStaticMarkup(
      <KnowledgeGraphExplorer
        selected={selected}
        edges={edges}
        total={3}
        vocabulary={vocabulary}
        query="ada"
        kind="person"
        locale="en"
      />,
    );
    expect(html).toContain('q=ada');
    expect(html).toContain('kind=person');
    expect(html).toContain('view=explorer');
  });

  it('states the true total when the first hop is capped', () => {
    const html = renderToStaticMarkup(
      <KnowledgeGraphExplorer
        selected={selected}
        edges={edges}
        total={85}
        vocabulary={vocabulary}
        query=""
        kind=""
        locale="en"
      />,
    );
    expect(html).toContain('of 85 active connections');
  });

  it('says so when there is nothing to explore', () => {
    const html = renderToStaticMarkup(
      <KnowledgeGraphExplorer
        selected={selected}
        edges={[]}
        total={0}
        vocabulary={vocabulary}
        query=""
        kind=""
        locale="en"
      />,
    );
    expect(html).toContain('No active connections to explore yet.');
  });
});
