import type { ImportOverviewData, ImportOverviewRepository, Records } from '@assistant/persistence';
import { FieldPath, type Query, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const PAGE_SIZE = 500;
const MAX_SOURCE_ROWS = 20_000;
const MAX_QUARANTINED_MEMORIES = 100_000;

async function scan(query: Query, maxRows: number, message: string) {
  const documents: QueryDocumentSnapshot[] = [];
  let cursor: QueryDocumentSnapshot | undefined;
  while (true) {
    let page = query.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    documents.push(...snapshot.docs);
    if (documents.length > maxRows) throw new Error(message);
    if (snapshot.size < PAGE_SIZE) return documents;
    cursor = snapshot.docs.at(-1);
  }
}

function ownedSource(doc: QueryDocumentSnapshot, agentId: string): Records['importSources'] {
  const source = decodeRecord<Records['importSources']>(doc.data());
  if (
    !source.id ||
    documentKey(source.id) !== doc.id ||
    source.agentId !== agentId ||
    !(source.createdAt instanceof Date) ||
    !(source.updatedAt instanceof Date) ||
    typeof source.source !== 'string' ||
    typeof source.workspacePath !== 'string'
  )
    throw new Error('Malformed or foreign import source record');
  return source;
}

/** Bounded owner import metadata and quarantine counts for workspace views. */
export class FirestoreImportOverviewRepository implements ImportOverviewRepository {
  readonly kind = 'import-overview-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async load(): Promise<ImportOverviewData> {
    const agent = await this.store.doc('agents', this.configuredAgentId).get();
    if (!agent.exists || agent.get('id') !== this.configuredAgentId)
      throw new Error('Configured Firestore agent is missing or malformed');
    const fence = await readPrivacyErasureFence(this.store, this.configuredAgentId);
    const [sourceDocs, quarantinedDocs] = await Promise.all([
      scan(
        this.store
          .collection('importSources')
          .where('agentId', '==', this.configuredAgentId) as Query,
        MAX_SOURCE_ROWS,
        'Import overview source scan exceeds its explicit limit',
      ),
      scan(
        this.store
          .collection('memories')
          .where('agentId', '==', this.configuredAgentId)
          .where('quarantined', '==', true) as Query,
        MAX_QUARANTINED_MEMORIES,
        'Import overview quarantine scan exceeds its explicit limit',
      ),
    ]);

    const sources = sourceDocs.map((doc) => ownedSource(doc, this.configuredAgentId));
    const sourceNames = new Set<string>();
    for (const source of sources) {
      if (sourceNames.has(source.source)) throw new Error('Duplicate import source identity');
      sourceNames.add(source.source);
    }
    const quarantineCounts = new Map<string, number>();
    for (const doc of quarantinedDocs) {
      const memory = decodeRecord<{
        id: string;
        agentId: string;
        quarantined: boolean;
        source?: string | null;
      }>(doc.data());
      if (
        !memory.id ||
        documentKey(memory.id) !== doc.id ||
        memory.agentId !== this.configuredAgentId ||
        memory.quarantined !== true
      )
        throw new Error('Malformed or foreign quarantined import memory');
      if (memory.source == null) continue;
      if (typeof memory.source !== 'string')
        throw new Error('Malformed quarantined import memory source');
      quarantineCounts.set(memory.source, (quarantineCounts.get(memory.source) ?? 0) + 1);
    }
    sources.sort(
      (left, right) =>
        right.updatedAt.getTime() - left.updatedAt.getTime() || right.id.localeCompare(left.id),
    );
    await assertPrivacyErasureFenceUnchanged(this.store, this.configuredAgentId, fence);
    return { sources, quarantineBySource: Object.fromEntries(quarantineCounts) };
  }
}
