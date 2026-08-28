import type { PredicateSpec } from '@assistant/application';
import { describe, expect, it } from 'vitest';
import {
  type ExplorerEdge,
  expansionAnnouncement,
  expansionChildren,
  familyForPredicate,
  groupEdges,
} from '@/app/profile/knowledge/explorer-model';

const vocabulary: readonly PredicateSpec[] = [
  { id: 'father_of', group: 'family', subjectKinds: ['person'], objectKinds: ['person'] },
  {
    id: 'works_at',
    group: 'work and education',
    subjectKinds: ['person'],
    objectKinds: ['organization'],
  },
];

function edge(
  id: string,
  predicate: string,
  otherId: string,
  reviewStatus: ExplorerEdge['reviewStatus'] = 'confirmed',
): ExplorerEdge {
  return {
    id,
    predicate,
    outbound: true,
    reviewStatus,
    validFrom: null,
    validUntil: null,
    other: { id: otherId, label: `Entity ${otherId}`, kind: 'person' },
  };
}

describe('familyForPredicate', () => {
  it('maps registry predicates to their group and everything else to other', () => {
    expect(familyForPredicate('father_of', vocabulary)).toBe('family');
    expect(familyForPredicate('works_at', vocabulary)).toBe('work and education');
    expect(familyForPredicate('custom_thing', vocabulary)).toBe('other');
  });
});

describe('groupEdges', () => {
  it('groups by family in registry order with Other last', () => {
    const groups = groupEdges(
      [edge('1', 'custom_thing', 'a'), edge('2', 'works_at', 'b'), edge('3', 'father_of', 'c')],
      vocabulary,
    );
    expect(groups.map((group) => group.label)).toEqual(['Family', 'Work and education', 'Other']);
  });

  it('leads with confirmed edges, then alphabetical, never reshuffling on expand', () => {
    const groups = groupEdges(
      [
        edge('1', 'father_of', 'z', 'unreviewed'),
        edge('2', 'father_of', 'a', 'confirmed'),
        edge('3', 'father_of', 'm'),
      ],
      vocabulary,
    );
    expect(groups[0]?.edges.map((item) => item.other.id)).toEqual(['a', 'm', 'z']);
  });
});

describe('expansionChildren', () => {
  it('drops anything on the ancestor chain so the outline never loops', () => {
    const children = expansionChildren(
      { edges: [edge('1', 'knows', 'a'), edge('2', 'knows', 'b')], total: 2 },
      ['centre', 'a'],
    );
    expect(children.map((child) => child.other.id)).toEqual(['b']);
  });
});

describe('expansionAnnouncement', () => {
  it('says when there is nothing new and counts what arrived', () => {
    expect(expansionAnnouncement('Ada', { edges: [edge('1', 'knows', 'a')], total: 1 }, [])).toBe(
      'Showing 1 connection around Ada.',
    );
    expect(expansionAnnouncement('Ada', { edges: [], total: 0 }, [])).toBe(
      'No further connections around Ada.',
    );
    expect(
      expansionAnnouncement('Ada', { edges: [edge('1', 'knows', 'centre')], total: 1 }, ['centre']),
    ).toBe('No further connections around Ada.');
  });
});
