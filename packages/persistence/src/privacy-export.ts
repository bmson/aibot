import type { Records } from './records.js';

type MemoryExportRow = Pick<
  Records['memories'],
  | 'id'
  | 'category'
  | 'kind'
  | 'content'
  | 'importance'
  | 'confidence'
  | 'originTrust'
  | 'quarantined'
  | 'domain'
  | 'ownerConfirmed'
  | 'pinned'
  | 'source'
  | 'createdAt'
  | 'expiresAt'
>;

type GraphEntityExportRow = Pick<
  Records['knowledgeGraphEntities'],
  | 'id'
  | 'canonicalKey'
  | 'label'
  | 'preferredLabel'
  | 'kind'
  | 'contactId'
  | 'createdAt'
  | 'updatedAt'
>;

type GraphAliasExportRow = Pick<
  Records['knowledgeGraphEntityAliases'],
  'canonicalKey' | 'entityId' | 'createdAt'
>;

type GraphRelationExportRow = Pick<
  Records['knowledgeGraphRelations'],
  | 'id'
  | 'subjectEntityId'
  | 'predicate'
  | 'objectEntityId'
  | 'sourceMemoryId'
  | 'evidenceQuote'
  | 'confidence'
  | 'validFrom'
  | 'validUntil'
  | 'reviewStatus'
  | 'createdAt'
>;

export interface LongTermMemoryExportData {
  memories: MemoryExportRow[];
  knowledgeGraph: {
    entities: GraphEntityExportRow[];
    aliases: GraphAliasExportRow[];
    relations: GraphRelationExportRow[];
  };
  people: Array<
    Pick<
      Records['contacts'],
      | 'id'
      | 'name'
      | 'aliases'
      | 'emails'
      | 'phones'
      | 'relationship'
      | 'trust'
      | 'notes'
      | 'createdAt'
      | 'updatedAt'
    >
  >;
  writingVoice: {
    samples: Array<
      Pick<Records['writingSamples'], 'id' | 'register' | 'text' | 'context' | 'createdAt'>
    >;
    profile: Omit<Records['voiceProfile'], 'id'> | null;
  };
  compiledOwnerCard: Records['ownerCard'] | null;
  situationPacks: Records['situationPacks'][];
}

export interface PrivacyExportRepository {
  readonly kind: 'privacy-export-repository';
  exportOwnerData(): Promise<LongTermMemoryExportData>;
}
