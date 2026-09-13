import type { KnowledgeMapSnapshot } from '@assistant/application';
import { describe, expect, it } from 'vitest';
import {
  FOCUS_RING_SIZE,
  GLOBAL_MAP_HEIGHT,
  GLOBAL_MAP_WIDTH,
  knowledgeConnections,
  knowledgeStartingPoints,
  layoutFocusRing,
  layoutKnowledgeMap,
  placeOverviewLabels,
  spokeLabelAnchor,
} from './knowledge-map-model';

const snapshot: KnowledgeMapSnapshot = {
  nodes: [
    { id: 'a', label: 'Ada', kind: 'person', component: 0, degree: 1 },
    { id: 'b', label: 'Analytical Engine', kind: 'project', component: 0, degree: 1 },
  ],
  edges: [
    {
      id: 'edge',
      subjectId: 'a',
      objectId: 'b',
      predicate: 'works_on',
      reviewStatus: 'confirmed',
      sourceMemoryId: 'memory',
      sourceContent: 'Ada works on the Analytical Engine.',
      evidenceQuote: 'Ada works on the Analytical Engine.',
      presentation: {
        sentence: 'Ada works on the Analytical Engine.',
        label: 'Works on',
        accessibleLabel: 'Ada works on the Analytical Engine.',
      },
      validFrom: null,
      validUntil: null,
    },
  ],
  components: [{ id: 0, nodes: 2, edges: 1, label: 'Ada' }],
  totalEdges: 1,
  truncated: false,
  filters: { query: '', kind: '', predicates: [], review: 'all', sourceMemoryId: '' },
};

describe('global knowledge map layout', () => {
  it('is deterministic and keeps every node inside the viewport', () => {
    const first = layoutKnowledgeMap(snapshot);
    expect(layoutKnowledgeMap(snapshot)).toEqual(first);
    expect(first).toHaveLength(2);
    for (const node of first) {
      expect(node.x).toBeGreaterThanOrEqual(24);
      expect(node.x).toBeLessThanOrEqual(GLOBAL_MAP_WIDTH - 24);
      expect(node.y).toBeGreaterThanOrEqual(24);
      expect(node.y).toBeLessThanOrEqual(GLOBAL_MAP_HEIGHT - 24);
    }
  });

  it('returns an empty layout for an empty graph', () => {
    expect(layoutKnowledgeMap({ ...snapshot, nodes: [], edges: [], components: [] })).toEqual([]);
  });

  it('ignores an edge whose endpoint is not on the map', () => {
    // The node cap can drop an endpoint while its edge survives upstream; the
    // relaxation must skip that pair rather than read past the node list.
    const dangling = {
      ...snapshot,
      edges: [...snapshot.edges, { ...snapshot.edges[0], id: 'ghost', objectId: 'missing' }],
    } as KnowledgeMapSnapshot;
    expect(layoutKnowledgeMap(dangling)).toEqual(layoutKnowledgeMap(snapshot));
  });

  it('separates two nodes it is asked to lay out in one component', () => {
    const laid = layoutKnowledgeMap(snapshot);
    const [a, b] = laid;
    expect(Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0))).toBeGreaterThan(20);
  });
});

describe('knowledge connections', () => {
  it('groups supporting sources without reversing incoming claims', () => {
    const edge = snapshot.edges[0];
    if (!edge) throw new Error('Missing fixture edge');
    const graph = {
      ...snapshot,
      edges: [edge, { ...edge, id: 'e2', sourceMemoryId: 'another' }, { ...edge, id: 'e3' }],
    };
    const groups = knowledgeConnections(graph, 'b');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.sources).toHaveLength(2);
    expect(groups[0]?.edge.presentation.sentence).toBe('Ada works on the Analytical Engine.');
  });

  it('keeps different directions and time spans separate', () => {
    const edge = snapshot.edges[0];
    if (!edge) throw new Error('Missing fixture edge');
    expect(
      knowledgeConnections(
        {
          ...snapshot,
          edges: [
            edge,
            { ...edge, id: 'reverse', subjectId: 'b', objectId: 'a' },
            { ...edge, id: 'past', validUntil: '2020' },
          ],
        },
        'a',
      ),
    ).toHaveLength(3);
  });

  it('does not upgrade an unreviewed connection to confirmed', () => {
    const original = snapshot.edges[0];
    if (!original) throw new Error('Missing fixture edge');
    const edge = { ...original, reviewStatus: 'unreviewed' as const };
    expect(knowledgeConnections({ ...snapshot, edges: [edge] }, 'a')[0]?.confirmed).toBe(false);
  });
});

const hub: KnowledgeMapSnapshot['nodes'][number] = {
  id: 'hub',
  label: 'Ada',
  kind: 'person',
  component: 0,
  degree: 3,
};

function edgeTo(
  id: string,
  overrides: Partial<KnowledgeMapSnapshot['edges'][number]> = {},
): KnowledgeMapSnapshot['edges'][number] {
  const base = snapshot.edges[0];
  if (!base) throw new Error('Missing fixture edge');
  return { ...base, id, subjectId: 'hub', objectId: 'b', ...overrides };
}

describe('focus ring layout', () => {
  const graph = (
    nodes: KnowledgeMapSnapshot['nodes'],
    edges: KnowledgeMapSnapshot['edges'],
  ): KnowledgeMapSnapshot => ({ ...snapshot, nodes, edges });

  it('puts the item in hand at the centre of the canvas', () => {
    const layout = layoutFocusRing(
      graph(
        [hub, { ...hub, id: 'b', label: 'Analytical Engine', kind: 'project' }],
        [edgeTo('e1')],
      ),
      'hub',
    );
    expect(layout?.centre.x).toBe(GLOBAL_MAP_WIDTH / 2);
    expect(layout?.centre.y).toBe(GLOBAL_MAP_HEIGHT / 2);
    expect(layout?.spokes).toHaveLength(1);
  });

  it('returns null for an item the snapshot does not hold', () => {
    expect(layoutFocusRing(graph([hub], []), 'missing')).toBeNull();
  });

  it('counts distinct claims per neighbour rather than source rows', () => {
    // Six emails recording the same fact are one spoke, not six — and not a
    // claim count of six either.
    const layout = layoutFocusRing(
      graph(
        [hub, { ...hub, id: 'b', label: 'Analytical Engine', kind: 'project' }],
        [
          edgeTo('e1', { sourceMemoryId: 'm1' }),
          edgeTo('e2', { sourceMemoryId: 'm2' }),
          edgeTo('e3', { sourceMemoryId: 'm3', predicate: 'funded' }),
        ],
      ),
      'hub',
    );
    expect(layout?.spokes).toHaveLength(1);
    expect(layout?.spokes[0]?.claims).toBe(2);
    expect(layout?.total).toBe(1);
  });

  it('keeps an incoming claim pointing the way it was recorded', () => {
    const layout = layoutFocusRing(
      graph(
        [hub, { ...hub, id: 'b', label: 'Grace', kind: 'person' }],
        [edgeTo('e1', { subjectId: 'b', objectId: 'hub' })],
      ),
      'hub',
    );
    expect(layout?.spokes[0]?.outbound).toBe(false);
  });

  it('drops a self-referential claim, which has no second endpoint to place', () => {
    const layout = layoutFocusRing(
      graph([hub], [edgeTo('e1', { subjectId: 'hub', objectId: 'hub' })]),
      'hub',
    );
    expect(layout?.spokes).toHaveLength(0);
    expect(layout?.total).toBe(0);
  });

  it('pages the most connected neighbours first and wraps out-of-range pages', () => {
    const neighbors = Array.from({ length: FOCUS_RING_SIZE + 3 }, (_, index) => ({
      ...hub,
      id: `n${index}`,
      label: `Neighbour ${index}`,
      degree: index,
    }));
    const edges = neighbors.map((node, index) => edgeTo(`e${index}`, { objectId: node.id }));
    const first = layoutFocusRing(graph([hub, ...neighbors], edges), 'hub', 0);
    expect(first?.pages).toBe(2);
    expect(first?.total).toBe(FOCUS_RING_SIZE + 3);
    expect(first?.spokes).toHaveLength(FOCUS_RING_SIZE);
    expect(first?.spokes[0]?.node.degree).toBe(FOCUS_RING_SIZE + 2);
    // Page 2 of 2 asked for as page 5 lands back inside the range rather than
    // rendering an empty ring with no way out.
    expect(layoutFocusRing(graph([hub, ...neighbors], edges), 'hub', 5)?.page).toBe(1);
    expect(layoutFocusRing(graph([hub, ...neighbors], edges), 'hub', -1)?.page).toBe(1);
  });

  it('separates every spoke it places', () => {
    const neighbors = Array.from({ length: FOCUS_RING_SIZE }, (_, index) => ({
      ...hub,
      id: `n${index}`,
      label: `Neighbour ${index}`,
      degree: 1,
    }));
    const layout = layoutFocusRing(
      graph(
        [hub, ...neighbors],
        neighbors.map((node, index) => edgeTo(`e${index}`, { objectId: node.id })),
      ),
      'hub',
    );
    const spokes = layout?.spokes ?? [];
    for (const [index, spoke] of spokes.entries()) {
      for (const other of spokes.slice(index + 1)) {
        expect(
          Math.hypot(spoke.node.x - other.node.x, spoke.node.y - other.node.y),
        ).toBeGreaterThan(40);
      }
    }
  });
});

describe('spoke label placement', () => {
  const centre = { x: 500, y: 320 };

  it('runs a flanking name outward from its dot', () => {
    expect(spokeLabelAnchor({ x: 810, y: 320 }, centre).anchor).toBe('start');
    expect(spokeLabelAnchor({ x: 190, y: 320 }, centre).anchor).toBe('end');
  });

  it('drops a name under a dot at the top or bottom of the ring', () => {
    expect(spokeLabelAnchor({ x: 500, y: 110 }, centre).dy).toBeLessThan(0);
    expect(spokeLabelAnchor({ x: 500, y: 530 }, centre).dy).toBeGreaterThan(0);
  });

  it('shortens a name that would otherwise run off the canvas', () => {
    // Anything else is clipped by the viewBox, which reads as a rendering
    // fault rather than as an abbreviation.
    const nearEdge = spokeLabelAnchor({ x: 940, y: 320 }, centre, 1000);
    const roomy = spokeLabelAnchor({ x: 700, y: 320 }, centre, 1000);
    expect(nearEdge.maxChars).toBeLessThan(roomy.maxChars);
    expect(nearEdge.maxChars).toBeGreaterThanOrEqual(8);
  });
});

describe('starting points', () => {
  it('groups the best-connected items by kind and skips unconnected ones', () => {
    const nodes: KnowledgeMapSnapshot['nodes'] = [
      { id: 'a', label: 'Ada', kind: 'person', component: 0, degree: 9 },
      { id: 'g', label: 'Grace', kind: 'person', component: 0, degree: 2 },
      { id: 'p', label: 'Engine', kind: 'project', component: 0, degree: 4 },
      { id: 'x', label: 'Orphan', kind: 'person', component: 1, degree: 0 },
    ];
    const groups = knowledgeStartingPoints({ ...snapshot, nodes });
    expect(groups.map((group) => group.kind)).toEqual(['person', 'project']);
    expect(groups[0]?.nodes.map((node) => node.id)).toEqual(['a', 'g']);
  });

  it('caps each kind at the requested size', () => {
    const nodes = Array.from({ length: 10 }, (_, index) => ({
      id: `n${index}`,
      label: `Person ${index}`,
      kind: 'person',
      component: 0,
      degree: index + 1,
    }));
    expect(knowledgeStartingPoints({ ...snapshot, nodes }, { perKind: 3 })[0]?.nodes).toHaveLength(
      3,
    );
  });
});

describe('overview label rationing', () => {
  const identity = { x: 0, y: 0, scale: 1 };
  const positioned = (id: string, x: number, y: number, degree: number) => ({
    id,
    label: `Item ${id}`,
    kind: 'person',
    component: 0,
    degree,
    x,
    y,
  });

  it('drops a name whose box lands on one already placed', () => {
    const placed = placeOverviewLabels(
      [positioned('a', 300, 300, 9), positioned('b', 302, 302, 1)],
      identity,
    );
    expect(placed.labels.map((label) => label.id)).toEqual(['a']);
    expect(placed.visible).toBe(2);
  });

  it('keeps both names once there is room between them', () => {
    expect(
      placeOverviewLabels([positioned('a', 200, 300, 9), positioned('b', 700, 300, 1)], identity)
        .labels,
    ).toHaveLength(2);
  });

  it('names the highest-degree item first when they compete', () => {
    const placed = placeOverviewLabels(
      [positioned('small', 300, 300, 1), positioned('big', 304, 300, 40)],
      identity,
    );
    expect(placed.labels.map((label) => label.id)).toEqual(['big']);
  });

  it('always names the selection, even against a bigger hub', () => {
    const placed = placeOverviewLabels(
      [positioned('big', 300, 300, 40), positioned('mine', 304, 300, 1)],
      identity,
      { always: new Set(['mine']) },
    );
    expect(placed.labels.map((label) => label.id)).toEqual(['mine']);
  });

  it('counts only the dots inside the frame, so zooming changes the number', () => {
    // The owner is told how many items are too crowded to name; counting ones
    // they cannot even see would make that number meaningless.
    const nodes = [positioned('near', 500, 300, 5), positioned('far', 4000, 300, 5)];
    expect(placeOverviewLabels(nodes, identity).visible).toBe(1);
    expect(placeOverviewLabels(nodes, { x: -3600, y: 0, scale: 1 }).visible).toBe(1);
  });

  it('never places a name that would be clipped by the canvas edge', () => {
    const placed = placeOverviewLabels([positioned('a', 998, 300, 9)], identity);
    expect(placed.labels).toHaveLength(0);
    expect(placed.visible).toBe(1);
  });
});
