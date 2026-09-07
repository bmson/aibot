import { describe, expect, it, vi } from 'vitest';
import type { ExplorerEdge } from './explorer-model';

vi.mock('./actions', () => ({
  loadKnowledgeNeighborhood: vi.fn(),
  loadConnectionSource: vi.fn(),
  removeKnowledgeConnection: vi.fn(),
}));

import { treeConnections } from './connection-tree';

const edge: ExplorerEdge = {
  id: 'one',
  predicate: 'parent_of',
  outbound: true,
  reviewStatus: 'confirmed',
  validFrom: null,
  validUntil: null,
  other: { id: 'robin', label: 'Robin', kind: 'person' },
};
describe('connection tree source grouping', () => {
  it('keeps duplicate evidence together without hiding its identifiers', () => {
    expect(
      treeConnections([edge, { ...edge, id: 'two', reviewStatus: 'unreviewed' }]).map((group) =>
        group.map((item) => item.id),
      ),
    ).toEqual([['one', 'two']]);
  });
  it('keeps opposite directions and historical claims separate', () => {
    expect(
      treeConnections([
        edge,
        { ...edge, id: 'reverse', outbound: false },
        { ...edge, id: 'old', validUntil: '2020' },
      ]),
    ).toHaveLength(3);
  });
});
