import type {
  DocumentCatalogOverview,
  DocumentCatalogReadRepository,
  DocumentCatalogView,
  DocumentChunkView,
} from '@assistant/persistence';
import { FieldPath } from '@google-cloud/firestore';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const DOCUMENT_PAGE_SIZE = 200;
const MAX_DOCUMENTS = 5_000;
const DOCUMENT_LIST_LIMIT = 200;
const MAX_DETAIL_CHUNKS = 1_000;

export type FirestoreDocumentView = DocumentCatalogView;
export type FirestoreDocumentChunkView = DocumentChunkView;

type DocumentRow = FirestoreDocumentView & { agentId: string; fileId: string };
type FileRow = { id: string; agentId: string; bytes?: number | null };
type ChunkRow = {
  id: string;
  agentId: string;
  documentId: string;
  chunkIndex: number;
  text: string;
  charCount: number;
};

async function assertConfiguredOwner(store: InstallationStore, agentId: string) {
  const agents = await store.collection('agents').limit(2).get();
  const owner = agents.docs[0];
  if (
    !agentId ||
    agents.size !== 1 ||
    !owner ||
    owner.id !== documentKey(agentId) ||
    owner.get('id') !== agentId
  )
    throw new Error('Documents require exactly one configured agent');
}

function owned<T extends { id: string; agentId: string }>(
  snapshot: FirebaseFirestore.QueryDocumentSnapshot,
  agentId: string,
): T | null {
  const row = decodeRecord<T>(snapshot.data());
  return row.agentId === agentId && documentKey(row.id) === snapshot.id ? row : null;
}

/** SQL-free Documents reads scoped to the configured installation owner. */
export class FirestoreDocumentReadRepository implements DocumentCatalogReadRepository {
  readonly kind = 'document-catalog-read-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async list(agentId: string): Promise<DocumentCatalogOverview> {
    if (!agentId || agentId !== this.configuredAgentId)
      throw new Error('Document read is outside the configured installation');
    await assertConfiguredOwner(this.store, agentId);
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const [allRows, primarySnapshot] = await Promise.all([
      this.readOwnerDocuments(agentId),
      this.store
        .collection('conversations')
        .where('agentId', '==', agentId)
        .where('isPrimary', '==', true)
        .limit(2)
        .get(),
    ]);
    if (primarySnapshot.size > 1)
      throw new Error('Documents found multiple primary conversations for the configured agent');
    const primaryDoc = primarySnapshot.docs[0];
    const primaryConversation = primaryDoc
      ? owned<{ id: string; agentId: string }>(primaryDoc, agentId)
      : null;
    let primaryConversationId: string | null = null;
    if (primaryDoc) {
      const conversation = decodeRecord<{
        id: string;
        agentId: string;
        channel: string;
        isPrimary: boolean;
      }>(primaryDoc.data());
      if (
        !primaryConversation ||
        conversation.channel !== 'chat' ||
        conversation.isPrimary !== true
      )
        throw new Error('Documents found an invalid primary conversation for the configured agent');
      primaryConversationId = conversation.id;
    }
    const stats = allRows.reduce(
      (result, row) => ({
        total: result.total + 1,
        ready: result.ready + (row.status === 'ready' ? 1 : 0),
        pending: result.pending + (row.status === 'pending' || row.status === 'extracting' ? 1 : 0),
        chunks: result.chunks + row.chunkCount,
      }),
      { total: 0, ready: 0, pending: 0, chunks: 0 },
    );
    const rows = allRows
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, DOCUMENT_LIST_LIMIT);
    const fileSnapshots = rows.length
      ? await this.store.db.getAll(...rows.map((row) => this.store.doc('files', row.fileId)))
      : [];
    const fileMap = new Map<string, FileRow>();
    for (const snapshot of fileSnapshots) {
      if (!snapshot.exists) continue;
      const file = decodeRecord<FileRow>(snapshot.data());
      if (file.agentId === agentId && documentKey(file.id) === snapshot.id)
        fileMap.set(file.id, file);
    }
    const listed = rows.map((row) => {
      const file = fileMap.get(row.fileId);
      if (!file)
        throw new Error(`Documents could not verify file ownership for document ${row.id}`);
      return {
        ...row,
        bytes: file.bytes ?? 0,
        error: typeof row.error === 'string' ? row.error : null,
      };
    });
    await assertConfiguredOwner(this.store, agentId);
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return {
      documents: listed.map(({ agentId: _agentId, fileId: _fileId, ...row }) => row),
      stats,
      primaryConversationId,
    };
  }

  async get(
    agentId: string,
    id: string,
  ): Promise<{ document: FirestoreDocumentView; chunks: FirestoreDocumentChunkView[] } | null> {
    if (!agentId || agentId !== this.configuredAgentId)
      throw new Error('Document read is outside the configured installation');
    await assertConfiguredOwner(this.store, agentId);
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const snapshot = await this.store.doc('documents', id).get();
    const row = snapshot.exists
      ? owned<DocumentRow>(snapshot as FirebaseFirestore.QueryDocumentSnapshot, agentId)
      : null;
    if (!row) {
      await assertConfiguredOwner(this.store, agentId);
      await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
      return null;
    }
    const [fileSnapshot, chunkSnapshot] = await Promise.all([
      this.store.doc('files', row.fileId).get(),
      this.store
        .collection('documentChunks')
        .where('agentId', '==', agentId)
        .where('documentId', '==', id)
        .limit(MAX_DETAIL_CHUNKS + 1)
        .get(),
    ]);
    if (chunkSnapshot.size > MAX_DETAIL_CHUNKS)
      throw new Error('Document detail exceeds the bounded chunk limit');
    const file = fileSnapshot.exists ? decodeRecord<FileRow>(fileSnapshot.data()) : null;
    if (!file || file.agentId !== agentId || file.id !== row.fileId)
      throw new Error(`Documents could not verify file ownership for document ${row.id}`);
    const chunks = chunkSnapshot.docs
      .flatMap((doc) => {
        const chunk = owned<ChunkRow>(doc, agentId);
        if (!chunk || chunk.documentId !== id)
          throw new Error('Document detail contains a chunk with invalid owner or identity');
        return [
          {
            chunkIndex: chunk.chunkIndex,
            text: chunk.text,
            charCount: chunk.charCount,
          },
        ];
      })
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
    await assertConfiguredOwner(this.store, agentId);
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    const {
      agentId: _agentId,
      fileId: _fileId,
      ...document
    } = {
      ...row,
      bytes: file.bytes ?? 0,
      error: typeof row.error === 'string' ? row.error : null,
    };
    return { document, chunks };
  }

  private async readOwnerDocuments(agentId: string): Promise<DocumentRow[]> {
    const query = this.store
      .collection('documents')
      .where('agentId', '==', agentId)
      .orderBy(FieldPath.documentId());
    const rows: DocumentRow[] = [];
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    let scanned = 0;
    for (;;) {
      const page = await (cursor ? query.startAfter(cursor) : query)
        .limit(DOCUMENT_PAGE_SIZE)
        .get();
      scanned += page.size;
      if (scanned > MAX_DOCUMENTS) throw new Error('Documents exceed the bounded owner scan limit');
      for (const snapshot of page.docs) {
        const row = owned<DocumentRow>(snapshot, agentId);
        if (!row) throw new Error('Documents contains a row with invalid owner or identity');
        rows.push(row);
      }
      if (page.size < DOCUMENT_PAGE_SIZE) return rows;
      cursor = page.docs.at(-1);
      if (!cursor) throw new Error('Documents owner scan cursor did not advance');
    }
  }
}
