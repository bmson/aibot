import type { PersonConnection, PersonRelation } from './people.js';
import { presentKnowledgeGraphRelation } from './relationship-presentation.js';

export interface PersonGraphEdgeInput {
  id: string;
  predicate: string;
  outbound: boolean;
  reviewStatus: 'confirmed' | 'unreviewed';
  validFrom: string | null;
  validUntil: string | null;
  other: {
    id: string;
    label: string;
    kind: string;
    canonicalKey: string;
  };
}

export interface PersonGraphProjection {
  location: string | null;
  origins: PersonConnection[];
  relations: PersonRelation[];
  connections: PersonConnection[];
}

const ORIGIN_PREDICATES = new Set(['met', 'met_at', 'met_during']);

/** Use the SQL dossier's stored edge direction and person/connection buckets. */
export function projectPersonGraph(
  personName: string,
  edges: PersonGraphEdgeInput[],
): PersonGraphProjection {
  const result: PersonGraphProjection = {
    location: null,
    origins: [],
    relations: [],
    connections: [],
  };
  for (const edge of edges) {
    const otherLabel = edge.other.label;
    const presentation = edge.outbound
      ? presentKnowledgeGraphRelation({
          subjectLabel: personName,
          predicate: edge.predicate,
          objectLabel: otherLabel,
        })
      : presentKnowledgeGraphRelation({
          subjectLabel: otherLabel,
          predicate: edge.predicate,
          objectLabel: personName,
        });
    const shared = {
      id: edge.id,
      sentence: presentation.sentence,
      label: presentation.label,
      otherLabel,
      validFrom: edge.validFrom,
      validUntil: edge.validUntil,
    };
    if (edge.other.kind === 'person') {
      const match = /^contact:([0-9a-f-]{36})$/i.exec(edge.other.canonicalKey);
      result.relations.push({
        ...shared,
        otherContactId: match?.[1] ?? null,
        otherEntityId: edge.other.id,
        reviewStatus: edge.reviewStatus,
      });
      if (ORIGIN_PREDICATES.has(edge.predicate))
        result.origins.push({ ...shared, otherKind: edge.other.kind });
      continue;
    }
    const connection = { ...shared, otherKind: edge.other.kind };
    if (
      edge.predicate === 'lives_in' &&
      edge.outbound &&
      edge.validUntil === null &&
      result.location === null
    ) {
      result.location = otherLabel;
      continue;
    }
    if (ORIGIN_PREDICATES.has(edge.predicate)) result.origins.push(connection);
    else result.connections.push(connection);
  }
  return result;
}
