import type { KnowledgeMapSnapshot } from '@assistant/application';
import { describe, expect, it } from 'vitest';
import {
  GLOBAL_MAP_HEIGHT,
  GLOBAL_MAP_WIDTH,
  knowledgeConnections,
  layoutKnowledgeMap,
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
