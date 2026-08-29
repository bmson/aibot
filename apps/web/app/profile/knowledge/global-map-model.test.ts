import type { KnowledgeMapSnapshot } from '@assistant/application';
import { describe, expect, it } from 'vitest';
import { GLOBAL_MAP_HEIGHT, GLOBAL_MAP_WIDTH, layoutKnowledgeMap } from './global-map-model';

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
    },
  ],
  components: [{ id: 0, nodes: 2, edges: 1, label: 'Ada' }],
  totalEdges: 1,
  truncated: false,
  filters: { query: '', kind: '', predicates: [], review: 'all' },
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
});
