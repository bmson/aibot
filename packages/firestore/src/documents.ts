import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

export type FirestoreDocumentView = {
  id: string;
  title: string;
  mime: string;
  source: string;
  trust: string;
  status: string;
  extractor: string;
  chunkCount: number;
  charCount: number;
  bytes: number;
  error: string | null;
  createdAt: Date;
};

export type FirestoreDocumentChunkView = { chunkIndex: number; text: string; charCount: number };

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
export class FirestoreDocumentReadRepository {
  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async list(agentId: string): Promise<{
    documents: FirestoreDocumentView[];
    stats: { total: number; ready: number; pending: number; chunks: number };
  }> {
    if (!agentId || agentId !== this.configuredAgentId)
      throw new Error('Document read is outside the configured installation');
    await assertConfiguredOwner(this.store, agentId);
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const [documentSnapshot, fileSnapshot] = await Promise.all([
      this.store.collection('documents').where('agentId', '==', agentId).get(),
      this.store.collection('files').where('agentId', '==', agentId).get(),
    ]);
    const files = new Map<string, FileRow>();
    for (const doc of fileSnapshot.docs) {
      const row = owned<FileRow>(doc, agentId);
      if (row) files.set(row.id, row);
    }
    const rows = documentSnapshot.docs.flatMap((doc) => {
      const row = owned<DocumentRow>(doc, agentId);
      if (!row) return [];
      const file = files.get(row.fileId);
      return [
        {
          ...row,
          bytes: file?.bytes ?? 0,
          error: typeof row.error === 'string' ? row.error : null,
        },
      ];
    });
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const stats = rows.reduce(
      (result, row) => ({
        total: result.total + 1,
        ready: result.ready + (row.status === 'ready' ? 1 : 0),
        pending: result.pending + (row.status === 'pending' || row.status === 'extracting' ? 1 : 0),
        chunks: result.chunks + row.chunkCount,
      }),
      { total: 0, ready: 0, pending: 0, chunks: 0 },
    );
    await assertConfiguredOwner(this.store, agentId);
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return {
      documents: rows.slice(0, 200).map(({ agentId: _agentId, fileId: _fileId, ...row }) => row),
      stats,
    };
  }

  async get(
    agentId: string,
    id: string,
  ): Promise<{
    document: FirestoreDocumentView;
    chunks: FirestoreDocumentChunkView[];
  } | null> {
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
        .get(),
    ]);
    const file = fileSnapshot.exists ? decodeRecord<FileRow>(fileSnapshot.data()) : null;
    const chunks = chunkSnapshot.docs
      .flatMap((doc) => {
        const chunk = owned<ChunkRow>(doc, agentId);
        return chunk && chunk.documentId === id
          ? [
              {
                chunkIndex: chunk.chunkIndex,
                text: chunk.text,
                charCount: chunk.charCount,
              },
            ]
          : [];
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
      bytes: file?.agentId === agentId && file.id === row.fileId ? (file.bytes ?? 0) : 0,
      error: typeof row.error === 'string' ? row.error : null,
    };
    return { document, chunks };
  }
}
