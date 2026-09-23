export type KnowledgeGraphEntityKind =
  | 'person'
  | 'organization'
  | 'project'
  | 'place'
  | 'event'
  | 'date'
  | 'topic';

export interface KnowledgeGraphSyncSource {
  id: string;
  agentId: string;
  content: string;
  contentHash: string;
  /** Fences changes that retain a content hash, including embedding rewrites. */
  retrievalRevision: string;
  confidence: string;
  subjectContactId: string | null;
  createdAt: Date;
}

export interface KnowledgeGraphSyncClaim {
  /** Opaque ownership token. Only the current token may publish or fail a source. */
  token: string;
  attempts: number;
}

export interface KnowledgeGraphSyncContact {
  id: string;
  name: string;
  aliases: string[];
}

export interface KnowledgeGraphSyncContext {
  agentId: string;
  timeZone: string;
  locale: string;
  contacts: KnowledgeGraphSyncContact[];
}

export interface KnowledgeGraphProjectionEntity {
  canonicalKey: string;
  label: string;
  kind: KnowledgeGraphEntityKind;
  contactId: string | null;
  /** Contacts and canonical dates overwrite labels; other spellings only improve them. */
  authoritativeLabel: boolean;
}

export interface KnowledgeGraphProjectionRelation {
  subject: KnowledgeGraphProjectionEntity;
  predicate: string;
  object: KnowledgeGraphProjectionEntity;
  evidenceQuote: string;
  sourceFingerprint: string;
  ordinal: number;
  confidence: string;
  validFrom: string | null;
  validUntil: string | null;
}

export interface KnowledgeGraphSyncRepository {
  readonly kind: 'knowledge-graph-sync-repository';
  now(): Date;
  hydrateContactLabels(agentId?: string): Promise<void>;
  candidates(input: {
    agentId?: string;
    limit: number;
    extractionVersion: number;
    leaseMs: number;
    now: Date;
  }): Promise<KnowledgeGraphSyncSource[]>;
  context(agentId: string): Promise<KnowledgeGraphSyncContext>;
  claim(input: {
    source: KnowledgeGraphSyncSource;
    extractionVersion: number;
    leaseMs: number;
    now: Date;
  }): Promise<KnowledgeGraphSyncClaim | null>;
  fail(input: {
    source: KnowledgeGraphSyncSource;
    claim: KnowledgeGraphSyncClaim;
    extractionVersion: number;
    status: 'failed' | 'quarantined';
    lastError: string;
    nextRetryAt: Date | null;
    now: Date;
  }): Promise<boolean>;
  replaceProjection(input: {
    source: KnowledgeGraphSyncSource;
    claim: KnowledgeGraphSyncClaim;
    extractionVersion: number;
    relations: KnowledgeGraphProjectionRelation[];
    now: Date;
  }): Promise<{ relationships: number; entities: number } | null>;
  removeOrphanedEntities(agentId?: string): Promise<number>;
  pendingCount(input: {
    agentId?: string;
    extractionVersion: number;
    leaseMs: number;
    now: Date;
  }): Promise<number>;
  taskSpendUsd(taskId: string): Promise<number>;
}

export function isKnowledgeGraphSyncRepository(
  value: unknown,
): value is KnowledgeGraphSyncRepository {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'knowledge-graph-sync-repository'
  );
}
