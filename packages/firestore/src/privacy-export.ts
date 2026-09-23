import type {
  LongTermMemoryExportData,
  PrivacyExportRepository,
  Records,
} from '@assistant/persistence';
import { FieldPath, type Query } from '@google-cloud/firestore';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const PAGE_SIZE = 200;

async function allRows<T>(query: Query): Promise<T[]> {
  const rows: T[] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let pageQuery = query.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) pageQuery = pageQuery.startAfter(cursor);
    const page = await pageQuery.get();
    for (const doc of page.docs) rows.push(decodeRecord<T>(doc.data()));
    cursor = page.docs.at(-1);
    if (page.size < PAGE_SIZE) return rows;
  }
}

function pick<T extends object, K extends keyof T>(row: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, row[key]])) as Pick<T, K>;
}

export class FirestorePrivacyExportRepository implements PrivacyExportRepository {
  readonly kind = 'privacy-export-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async exportOwnerData(): Promise<LongTermMemoryExportData> {
    const agentPage = await this.store
      .collection('agents')
      .orderBy(FieldPath.documentId())
      .limit(2)
      .get();
    const agentDoc = agentPage.docs[0];
    const agent = agentDoc ? decodeRecord<Records['agents']>(agentDoc.data()) : undefined;
    if (
      agentPage.size !== 1 ||
      !agent ||
      typeof agent.id !== 'string' ||
      documentKey(agent.id) !== agentDoc?.id
    )
      throw new Error('Privacy export requires exactly one configured agent');
    const agentId = agent.id;
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const owned = (collection: string) =>
      allRows<Record<string, unknown>>(
        this.store.collection(collection).where('agentId', '==', agentId),
      );
    const [
      memoryRows,
      tombstones,
      entities,
      aliases,
      relations,
      people,
      samples,
      profiles,
      card,
      packs,
    ] = await Promise.all([
      owned('memories'),
      allRows<Records['memoryTombstones']>(this.store.collection('memoryTombstones')),
      owned('knowledgeGraphEntities'),
      owned('knowledgeGraphEntityAliases'),
      owned('knowledgeGraphRelations'),
      allRows<Records['contacts']>(this.store.collection('contacts')),
      allRows<Records['writingSamples']>(this.store.collection('writingSamples')),
      allRows<Records['voiceProfile']>(this.store.collection('voiceProfile')),
      this.store.doc('ownerCards', agentId).get(),
      owned('situationPacks'),
    ]);
    const profile = profiles.find((row) => row.id === 1);
    const tombstonedHashes = new Set(tombstones.map((row) => row.contentHash));
    const activeMemories = memoryRows.filter(
      (row) =>
        typeof row.id === 'string' &&
        typeof row.contentHash === 'string' &&
        !tombstonedHashes.has(row.contentHash),
    );
    const activeMemoryIds = new Set(activeMemories.map((row) => row.id));
    const cardRow = card.exists
      ? decodeRecord<{ agentId?: unknown; content?: unknown; compiledAt?: unknown }>(card.data())
      : null;
    const result: LongTermMemoryExportData = {
      memories: activeMemories.map((row) =>
        pick(row, [
          'id',
          'category',
          'kind',
          'content',
          'importance',
          'confidence',
          'originTrust',
          'quarantined',
          'domain',
          'ownerConfirmed',
          'pinned',
          'source',
          'createdAt',
          'expiresAt',
        ]),
      ) as LongTermMemoryExportData['memories'],
      knowledgeGraph: {
        entities: entities.map((row) =>
          pick(row, [
            'id',
            'canonicalKey',
            'label',
            'preferredLabel',
            'kind',
            'contactId',
            'createdAt',
            'updatedAt',
          ]),
        ) as LongTermMemoryExportData['knowledgeGraph']['entities'],
        aliases: aliases.map((row) =>
          pick(row, ['canonicalKey', 'entityId', 'createdAt']),
        ) as LongTermMemoryExportData['knowledgeGraph']['aliases'],
        relations: relations
          .filter(
            (row) =>
              typeof row.sourceMemoryId === 'string' && activeMemoryIds.has(row.sourceMemoryId),
          )
          .map((row) =>
            pick(row, [
              'id',
              'subjectEntityId',
              'predicate',
              'objectEntityId',
              'sourceMemoryId',
              'evidenceQuote',
              'confidence',
              'validFrom',
              'validUntil',
              'reviewStatus',
              'createdAt',
            ]),
          ) as LongTermMemoryExportData['knowledgeGraph']['relations'],
      },
      people: people.map((row) =>
        pick(row, [
          'id',
          'name',
          'aliases',
          'emails',
          'phones',
          'relationship',
          'trust',
          'notes',
          'createdAt',
          'updatedAt',
        ]),
      ),
      writingVoice: {
        samples: samples.map((row) =>
          pick(row, ['id', 'register', 'text', 'context', 'createdAt']),
        ),
        profile: profile
          ? pick(profile, ['description', 'dos', 'donts', 'signature', 'updatedAt'])
          : null,
      },
      compiledOwnerCard:
        cardRow?.agentId === agentId &&
        typeof cardRow.content === 'string' &&
        cardRow.compiledAt instanceof Date
          ? { id: 1, content: cardRow.content, compiledAt: cardRow.compiledAt }
          : null,
      situationPacks: packs.map((row) =>
        pick(row, [
          'id',
          'agentId',
          'creationKey',
          'title',
          'version',
          'archived',
          'data',
          'createdAt',
          'updatedAt',
        ]),
      ) as Records['situationPacks'][],
    };
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return result;
  }
}
