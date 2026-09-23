import { createHash } from 'node:crypto';
import type { DocumentCatalogRepository, Records } from '@assistant/persistence';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type DocumentRow = Records['documents'];
type FileRow = Records['files'];
type DedupClaim = {
  id: string;
  agentId: string;
  sha256: string;
  documentId: string;
};

function dedupClaimId(agentId: string, sha256: string): string {
  return createHash('sha256').update(`${agentId}\0${sha256}`).digest('hex');
}

function assertInput(file: FileRow, document: DocumentRow, configuredAgentId: string): void {
  if (
    !configuredAgentId ||
    file.agentId !== configuredAgentId ||
    document.agentId !== configuredAgentId
  )
    throw new Error('Document catalog write is outside the configured owner');
  if (!file.id || !document.id || document.fileId !== file.id)
    throw new Error('Document catalog record identity is invalid');
  documentKey(file.id);
  documentKey(document.id);
  if (file.taskId !== null) throw new Error('Document catalog files cannot belong to a task');
  if (
    !/^[0-9a-f]{64}$/.test(file.sha256 ?? '') ||
    file.sha256 !== document.sha256 ||
    file.mime !== document.mime ||
    !file.workspacePath ||
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 0
  )
    throw new Error('Document catalog file metadata is invalid');
  if (
    !document.title ||
    document.title.length > 300 ||
    !document.mime ||
    !['upload', 'email', 'drive'].includes(document.source) ||
    !['owner', 'known', 'unknown', 'assistant'].includes(document.trust) ||
    !['pending', 'unsupported'].includes(document.status) ||
    !['text', 'pdf', 'pending_processor', 'unsupported'].includes(document.extractor) ||
    (document.extractor === 'unsupported') !== (document.status === 'unsupported') ||
    document.chunkCount !== 0 ||
    document.charCount !== 0 ||
    document.processorTokenHash !== null ||
    document.processorStartedAt !== null ||
    document.processedTextPath !== null ||
    document.processorAttempts !== 0 ||
    !(document.createdAt instanceof Date) ||
    !Number.isFinite(document.createdAt.getTime()) ||
    !(document.updatedAt instanceof Date) ||
    !Number.isFinite(document.updatedAt.getTime()) ||
    !(file.createdAt instanceof Date) ||
    !Number.isFinite(file.createdAt.getTime())
  )
    throw new Error('Document catalog input must describe an unprocessed document');
}

function validDocument(snapshot: FirebaseFirestore.DocumentSnapshot, agentId: string): DocumentRow {
  const row = decodeRecord<DocumentRow>(snapshot.data());
  if (!row.id || documentKey(row.id) !== snapshot.id || row.agentId !== agentId)
    throw new Error('Document catalog found an invalid document record');
  return row;
}

function validFile(
  snapshot: FirebaseFirestore.DocumentSnapshot,
  agentId: string,
  expectedSha256: string,
): FileRow {
  const row = decodeRecord<FileRow>(snapshot.data());
  if (
    !row.id ||
    documentKey(row.id) !== snapshot.id ||
    row.agentId !== agentId ||
    row.sha256 !== expectedSha256
  )
    throw new Error('Document catalog found a file with invalid owner, identity, or content hash');
  return row;
}

/**
 * Atomic Firestore record boundary for document ingest. It persists only the
 * source file inventory and unprocessed document record; callers remain
 * responsible for blob rollback and processor/task scheduling.
 */
export class FirestoreDocumentCatalogRepository implements DocumentCatalogRepository {
  readonly kind = 'document-catalog-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async createDocumentCatalog(input: {
    file: FileRow;
    document: DocumentRow;
  }): Promise<{ document: DocumentRow; duplicate: boolean }> {
    assertInput(input.file, input.document, this.configuredAgentId);
    const { agentId } = input.document;
    const claimId = dedupClaimId(agentId, input.document.sha256);
    const claimRef = this.store.doc('documentDedupKeys', claimId);
    const fileRef = this.store.doc('files', input.file.id);
    const documentRef = this.store.doc('documents', input.document.id);

    return this.store.db.runTransaction(async (tx) => {
      const owners = await tx.get(this.store.collection('agents').limit(2));
      const owner = owners.docs[0];
      if (
        owners.size !== 1 ||
        !owner ||
        owner.id !== documentKey(agentId) ||
        owner.get('id') !== agentId
      )
        throw new Error('Documents require exactly one configured agent');

      const [erasure, claim, candidateFile, candidateDocument] = await tx.getAll(
        this.store.doc('privacyErasureJobs', agentId),
        claimRef,
        fileRef,
        documentRef,
      );
      if (
        erasure?.exists &&
        (erasure.get('agentId') !== agentId || privacyErasureIsActive(erasure.get('status')))
      )
        throw new Error('Privacy erasure is in progress');

      if (claim?.exists) {
        const key = decodeRecord<DedupClaim>(claim.data());
        if (
          documentKey(key.id) !== claim.id ||
          key.id !== dedupClaimId(agentId, input.document.sha256) ||
          key.agentId !== agentId ||
          key.sha256 !== input.document.sha256 ||
          !key.documentId
        )
          throw new Error('Document deduplication claim is malformed');
        const existingRef = this.store.doc('documents', key.documentId);
        const existingSnapshot = await tx.get(existingRef);
        if (!existingSnapshot.exists) throw new Error('Document deduplication claim is stale');
        const existing = validDocument(existingSnapshot, agentId);
        if (existing.agentId !== agentId || existing.sha256 !== input.document.sha256)
          throw new Error('Document deduplication claim points outside its owner or hash');
        const existingFileSnapshot = await tx.get(this.store.doc('files', existing.fileId));
        if (!existingFileSnapshot.exists) throw new Error('Duplicate document file is missing');
        validFile(existingFileSnapshot, agentId, input.document.sha256);
        return { document: existing, duplicate: true };
      }

      // Older imported catalogs predate claim documents. A single-field hash
      // query adopts the existing row without a migration-time claim backfill.
      const existingRows = await tx.get(
        this.store.collection('documents').where('sha256', '==', input.document.sha256).limit(2),
      );
      if (existingRows.size > 1)
        throw new Error('Document catalog contains multiple records with the same content hash');
      for (const snapshot of existingRows.docs) {
        const existing = validDocument(snapshot, agentId);
        if (documentKey(existing.id) !== snapshot.id || existing.agentId !== agentId)
          throw new Error('Document catalog contains an invalid owner record');
        if (existing.sha256 !== input.document.sha256) continue;
        const existingFileSnapshot = await tx.get(this.store.doc('files', existing.fileId));
        if (!existingFileSnapshot.exists) throw new Error('Duplicate document file is missing');
        validFile(existingFileSnapshot, agentId, input.document.sha256);
        const key: DedupClaim = {
          id: claimId,
          agentId,
          sha256: input.document.sha256,
          documentId: existing.id,
        };
        tx.create(claimRef, encodeRecord(key));
        return { document: existing, duplicate: true };
      }

      if (candidateFile?.exists || candidateDocument?.exists)
        throw new Error('Document catalog record ID collision');

      const key: DedupClaim = {
        id: claimId,
        agentId,
        sha256: input.document.sha256,
        documentId: input.document.id,
      };
      tx.create(fileRef, encodeRecord(input.file));
      tx.create(documentRef, encodeRecord(input.document));
      tx.create(claimRef, encodeRecord(key));
      return { document: input.document, duplicate: false };
    });
  }
}
