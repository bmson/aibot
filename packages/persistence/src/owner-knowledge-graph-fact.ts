export type OwnerKnowledgeGraphEntityKind =
  | 'person'
  | 'organization'
  | 'project'
  | 'place'
  | 'event'
  | 'date'
  | 'topic';

export interface OwnerKnowledgeGraphFactEndpointInput {
  label: string;
  kind: OwnerKnowledgeGraphEntityKind;
  id?: string;
  contactId?: string;
}

export interface OwnerKnowledgeGraphFactInput {
  subject: OwnerKnowledgeGraphFactEndpointInput;
  predicate: string;
  object: OwnerKnowledgeGraphFactEndpointInput;
  note: string;
}

export interface OwnerKnowledgeGraphFactResult {
  memoryId?: string;
  relationId?: string;
  error?: string;
}

export interface OwnerKnowledgeGraphFactContext {
  agentId: string;
  timeZone: string;
  locale: string;
  contacts: Array<{ id: string; name: string; aliases: string[] }>;
}

export interface OwnerKnowledgeGraphEntityEndpoint {
  id?: string;
  label: string;
  kind: OwnerKnowledgeGraphEntityKind;
  canonicalKey: string;
  contactId: string | null;
  authoritativeLabel: boolean;
  /** Original typed spelling, used to revalidate alias-based contact resolution at commit. */
  matchedContactLabel?: string;
}

export interface OwnerKnowledgeGraphFactAtomicInput {
  agentId: string;
  content: string;
  contentHash: string;
  embedding: number[];
  subject: OwnerKnowledgeGraphEntityEndpoint;
  predicate: string;
  object: OwnerKnowledgeGraphEntityEndpoint;
  subjectContactId: string | null;
  createdAt: Date;
  extractionVersion: number;
}

/** Persistence-neutral reads and one atomic owner memory/source/graph commit. */
export interface OwnerKnowledgeGraphFactRepository {
  readonly kind: 'owner-knowledge-graph-fact-repository';
  context(agentId?: string): Promise<OwnerKnowledgeGraphFactContext>;
  entity(agentId: string, entityId: string): Promise<OwnerKnowledgeGraphEntityEndpoint | null>;
  createAtomic(input: OwnerKnowledgeGraphFactAtomicInput): Promise<OwnerKnowledgeGraphFactResult>;
}

export function isOwnerKnowledgeGraphFactRepository(
  value: unknown,
): value is OwnerKnowledgeGraphFactRepository {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'owner-knowledge-graph-fact-repository'
  );
}
