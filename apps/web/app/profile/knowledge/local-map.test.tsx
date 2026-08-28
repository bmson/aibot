import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LocalMap } from '@/app/profile/knowledge/local-map';
import type { MapEdgeInput } from '@/app/profile/knowledge/local-map-model';

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

  it('keeps the canvas quiet until selection, with zoom controls always present', () => {
    const html = renderToStaticMarkup(
      <LocalMap selected={selected} initialEdges={edges(2)} totalEdges={2} query="" kind="" />,
    );
    // Node actions live in the selection toolbar, which renders only after a
    // node is selected — no per-node buttons clutter the drawing.
    expect(html).not.toContain('Show connections around');
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

  it('lists the bounded map facts as readable relationship sentences', () => {
    const html = renderToStaticMarkup(
      <LocalMap
        selected={selected}
        initialEdges={[
          {
            id: 'daughter',
            predicate: 'daughter_of',
            outbound: false,
            reviewStatus: 'confirmed',
            other: { id: 'freyja', label: 'Freyja_Ruth', kind: 'person' },
          },
        ]}
        totalEdges={1}
        query=""
        kind=""
      />,
    );
    expect(html).toContain('Freyja Ruth is Ada Lovelace&#x27;s daughter.');
  });

  it('says so when there is nothing to draw', () => {
    const html = renderToStaticMarkup(
      <LocalMap selected={selected} initialEdges={[]} totalEdges={0} query="" kind="" />,
    );
    expect(html).toContain('No active connections to draw yet.');
  });

  it('pages a crowded kind behind a "+N more" node instead of piling up', () => {
    const many: MapEdgeInput[] = Array.from({ length: 30 }, (_, index) => ({
      id: `d${index}`,
      predicate: 'on',
      outbound: true,
      reviewStatus: 'confirmed',
      other: { id: `date-${index}`, label: `Day ${index + 1}`, kind: 'date' },
    }));
    const html = renderToStaticMarkup(
      <LocalMap selected={selected} initialEdges={many} totalEdges={30} query="" kind="" />,
    );
    // Twelve dates render (labels page in lexicographic order: Day 1, Day
    // 10-19, Day 2); the rest collapse into one labelled pager control.
    expect(html).toContain('Day 12');
    expect(html).not.toContain('Day 3</text>');
    expect(html).not.toContain('Day 20</text>');
    expect(html).toContain('+18 more');
    expect(html).toContain('Show more date connections (18 not shown)');
  });
});
