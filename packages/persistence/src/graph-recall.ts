export interface GraphRelation {
  relationId: string;
  subjectEntityId: string;
  subjectLabel: string;
  predicate: string;
  objectEntityId: string;
  objectLabel: string;
  sourceMemoryId: string;
  content: string;
  evidenceQuote: string | null;
  createdAt: Date;
  confidence: string | number;
  /** Canonical date keys bounding the relationship's span, when stated. */
  validFrom: string | null;
  validUntil: string | null;
  similarity?: number | string;
}

export interface GraphRecallRepository {
  readonly kind: 'graph-recall-repository';
  seeds(input: {
    agentId: string;
    embedding: number[];
    limit: number;
    extractionVersion: number;
  }): Promise<GraphRelation[]>;
  connected(input: {
    agentId: string;
    entityIds: string[];
    sourceMemoryIds: string[];
    limit: number;
    extractionVersion: number;
  }): Promise<GraphRelation[]>;
}
