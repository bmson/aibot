import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapEdgeInput } from '@/app/profile/knowledge/local-map-model';

// The server action is never called during a static render, but importing the
// real module would drag the whole server composition root into the test.
vi.mock('@/app/profile/knowledge/actions', () => ({
  loadKnowledgeNeighborhood: vi.fn(async () => ({ edges: [], total: 0 })),
}));

import { LocalMap } from '@/app/profile/knowledge/local-map';

const selected = { id: 'c', label: 'Ada Lovelace', kind: 'person' };

function edges(count: number): MapEdgeInput[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `e${index}`,
    predicate: 'knows',
    outbound: index % 2 === 0,
    reviewStatus: index % 3 === 0 ? 'unreviewed' : 'confirmed',
    other: { id: `n${index}`, label: `Neighbour ${index}`, kind: 'project' },
  }));
}

describe('LocalMap static render', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('draws every first-hop neighbour as a link that keeps search and filter', () => {
    const html = renderToStaticMarkup(
      <LocalMap
        selected={selected}
        initialEdges={edges(3)}
        totalEdges={3}
        query="ada"
        kind="person"
      />,
    );
    expect(html).toContain('Connections around Ada Lovelace');
    for (let index = 0; index < 3; index += 1) {
      expect(html).toContain(`Neighbour ${index}`);
      expect(html).toContain(`entity=n${index}`);
    }
    expect(html).toContain('q=ada');
    expect(html).toContain('kind=person');
  });

  it('exposes an expand control per neighbour and zoom controls', () => {
    const html = renderToStaticMarkup(
      <LocalMap selected={selected} initialEdges={edges(2)} totalEdges={2} query="" kind="" />,
    );
    expect(html).toContain('Show connections around Neighbour 0');
    expect(html).toContain('aria-label="Zoom in"');
    expect(html).toContain('aria-label="Zoom out"');
    expect(html).toContain('aria-label="Reset view"');
  });

  it('reports the true total when the first hop is capped', () => {
    const html = renderToStaticMarkup(
      <LocalMap selected={selected} initialEdges={edges(3)} totalEdges={85} query="" kind="" />,
    );
    expect(html).toContain('Showing 3 of 85 active connections.');
  });

  it('keeps the text equivalent for anyone not reading the drawing', () => {
    const html = renderToStaticMarkup(
      <LocalMap selected={selected} initialEdges={edges(2)} totalEdges={2} query="" kind="" />,
    );
    expect(html).toContain('Neighbour 0 (Project)');
    expect(html).toContain('knows');
    expect(html).toContain('needs review');
  });

  it('says so when there is nothing to draw', () => {
    const html = renderToStaticMarkup(
      <LocalMap selected={selected} initialEdges={[]} totalEdges={0} query="" kind="" />,
    );
    expect(html).toContain('No active connections to draw yet.');
  });
});
