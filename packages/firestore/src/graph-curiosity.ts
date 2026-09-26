import type {
  GraphCuriosityRepository,
  GraphGapEntity,
  GraphGapRelation,
  Records,
} from '@assistant/persistence';
import type { QueryDocumentSnapshot } from '@google-cloud/firestore';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

type Entity = Records['knowledgeGraphEntities'];
type Relation = Records['knowledgeGraphRelations'];
type Memory = Records['memories'] & { supersededById?: string | null };
type Source = Records['knowledgeGraphSources'];

const PAGE = 400;
/** Owner graph rows read per run; the curiosity job runs once a day. */
const SCAN_LIMIT = 100_000;
const GETALL_CHUNK = 300;
const IN_LIMIT = 30;

/**
 * The curiosity job's graph reads on Firestore. The joins PostgreSQL does in
 * SQL are done here over the owner's rows, with the same definition of an
 * active relation that graph recall uses, including superseded memories.
 */
export class FirestoreGraphCuriosityRepository implements GraphCuriosityRepository {
  readonly kind = 'graph-curiosity-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {}

  private owned(agentId: string): void {
    if (agentId !== this.agentId) throw new Error('Curiosity is outside the configured owner');
  }

  private async byAgent<T extends { id: string; agentId: string }>(
    collection: string,
    fields?: string[],
  ): Promise<T[]> {
    const rows: T[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = this.store.collection(collection).where('agentId', '==', this.agentId);
      if (fields) query = query.select(...fields);
      query = query.limit(PAGE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        const row = decodeRecord<T>(doc.data());
        if (
          row.agentId === this.agentId &&
          typeof row.id === 'string' &&
          documentKey(row.id) === doc.id
        )
          rows.push(row);
      }
      if (rows.length > SCAN_LIMIT)
        throw new Error(`Curiosity ${collection} scan exceeds its limit`);
      cursor = page.docs.at(-1);
      if (page.size < PAGE) return rows;
    }
  }

  private async sources(memoryIds: string[]): Promise<Map<string, Source>> {
    const result = new Map<string, Source>();
    for (let index = 0; index < memoryIds.length; index += GETALL_CHUNK) {
      const batch = memoryIds.slice(index, index + GETALL_CHUNK);
      if (batch.length === 0) continue;
      const docs = await this.store.db.getAll(
        ...batch.map((id) => this.store.doc('knowledgeGraphSources', id)),
      );
      batch.forEach((id, position) => {
        const doc = docs[position];
        if (!doc?.exists) return;
        const row = decodeRecord<Source>(doc.data());
        // Imported source checkpoints can lack agentId; the memory id is the join.
        if (row.memoryId === id) result.set(id, row);
      });
    }
    return result;
  }

  async gapInputs(
    agentId: string,
    input: { now: Date; minRelations: number; maxCandidates: number; extractionVersion: number },
  ): Promise<{ connected: GraphGapEntity[]; held: GraphGapRelation[] }> {
    this.owned(agentId);
    const [entities, relations, memories] = await Promise.all([
      this.byAgent<Entity>('knowledgeGraphEntities'),
      this.byAgent<Relation>('knowledgeGraphRelations'),
      this.byAgent<Memory>('memories', [
        'id',
        'agentId',
        'category',
        'quarantined',
        'supersededById',
        'expiresAt',
        'embedding',
        'contentHash',
      ]),
    ]);
    const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
    const sources = await this.sources(
      [...new Set(relations.map((relation) => relation.sourceMemoryId))].filter((id) =>
        memoryById.has(id),
      ),
    );
    const active = relations.filter((relation) => {
      const memory = memoryById.get(relation.sourceMemoryId);
      const source = sources.get(relation.sourceMemoryId);
      return (
        !!memory &&
        !!source &&
        memory.category === 'knowledge' &&
        memory.quarantined === false &&
        !memory.supersededById &&
        (memory.expiresAt === null ||
          memory.expiresAt === undefined ||
          (memory.expiresAt instanceof Date && memory.expiresAt > input.now)) &&
        memory.embedding !== null &&
        memory.embedding !== undefined &&
        source.status === 'ready' &&
        source.contentHash === memory.contentHash &&
        source.extractionVersion >= input.extractionVersion &&
        relation.reviewStatus !== 'rejected' &&
        relation.evidenceQuote !== null &&
        relation.evidenceQuote !== undefined
      );
    });

    const entityById = new Map(entities.map((entity) => [entity.id, entity]));
    const label = (entity: Entity) => entity.preferredLabel || entity.label;
    const degree = new Map<string, number>();
    for (const relation of active)
      degree.set(relation.subjectEntityId, (degree.get(relation.subjectEntityId) ?? 0) + 1);
    const connected = [...degree.entries()]
      .filter(([, count]) => count >= input.minRelations)
      .flatMap(([id, count]) => {
        const entity = entityById.get(id);
        return entity
          ? [
              {
                id,
                label: label(entity),
                kind: entity.kind,
                contactId: entity.contactId ?? null,
                degree: count,
                sortLabel: entity.label,
              },
            ]
          : [];
      })
      // PostgreSQL orders by the extracted label, in byte order.
      .sort((a, b) =>
        a.sortLabel < b.sortLabel ? -1 : a.sortLabel > b.sortLabel ? 1 : a.id < b.id ? -1 : 1,
      )
      .slice(0, input.maxCandidates)
      .map(({ sortLabel: _sortLabel, ...entity }) => entity);

    const candidates = new Set(connected.map((entity) => entity.id));
    const held = active.flatMap((relation) => {
      const object = entityById.get(relation.objectEntityId);
      if (!candidates.has(relation.subjectEntityId) || !object) return [];
      return [
        {
          id: relation.id,
          subjectEntityId: relation.subjectEntityId,
          predicate: relation.predicate,
          reviewStatus: relation.reviewStatus,
          confidence: String(relation.confidence),
          validUntil: relation.validUntil ?? null,
          objectLabel: label(object),
        },
      ];
    });
    return { connected, held };
  }

  async askedKeys(agentId: string, keys: string[]): Promise<string[]> {
    this.owned(agentId);
    const asked: string[] = [];
    for (let index = 0; index < keys.length; index += IN_LIMIT) {
      const snapshot = await this.store
        .collection('suggestions')
        .where('agentId', '==', agentId)
        .where('sourceRef', 'in', keys.slice(index, index + IN_LIMIT))
        .select('sourceRef')
        .get();
      for (const doc of snapshot.docs) asked.push(String(doc.get('sourceRef')));
    }
    return asked;
  }
}
