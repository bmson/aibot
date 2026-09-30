import type { KnowledgeMapEdgeRecord } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import {
  assembleKnowledgeMapSnapshot,
  knowledgeMapFilters,
  MAP_OVERVIEW_EDGE_LIMIT,
} from './knowledge-workspace-queries.js';

function edge(id: string, objectId = 'recent'): KnowledgeMapEdgeRecord {
  return {
    id,
    subjectId: 'owner',
    subjectLabel: 'Owner',
    subjectKind: 'person',
    subjectContactId: null,
    objectId,
    objectLabel: objectId,
    objectKind: 'person',
    objectContactId: null,
    predicate: 'parent_of',
    reviewStatus: 'confirmed',
    sourceMemoryId: id,
    sourceContent: 'Recorded family connection',
    evidenceQuote: 'Recorded family connection',
    validFrom: null,
    validUntil: null,
  };
}

describe('complete graph overview', () => {
  it('keeps older people beyond the former 200-item bound and repeated recent evidence', async () => {
    const rows = [
      ...Array.from({ length: 501 }, (_, i) => edge(`recent-${i}`)),
      ...Array.from({ length: 350 }, (_, i) => edge(`old-${i}`, `person-${i}`)),
    ];
    const graph = await assembleKnowledgeMapSnapshot({
      rows,
      totalEdges: rows.length,
      filters: knowledgeMapFilters({}),
      completeOverview: true,
    });
    expect(graph.nodes).toHaveLength(352);
    expect(graph.edges).toHaveLength(rows.length);
    expect(graph.nodes.some((node) => node.id === 'person-349')).toBe(true);
    expect(graph.truncated).toBe(false);
  });

  it('reserves room for distinct connections before extra evidence and reports actual truncation', async () => {
    const rows = [
      ...Array.from({ length: MAP_OVERVIEW_EDGE_LIMIT }, (_, i) => edge(`recent-${i}`)),
      edge('old', 'grandmother'),
    ];
    const graph = await assembleKnowledgeMapSnapshot({
      rows,
      totalEdges: rows.length,
      filters: knowledgeMapFilters({}),
      completeOverview: true,
    });
    expect(graph.nodes.some((node) => node.id === 'grandmother')).toBe(true);
    expect(graph.edges.some((edge) => edge.id === 'old')).toBe(true);
    expect(graph.edges).toHaveLength(MAP_OVERVIEW_EDGE_LIMIT);
    expect(graph.truncated).toBe(true);
  });
});
