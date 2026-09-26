import type { DocumentDeletionRepository, Records } from '@assistant/persistence';
import { dedupClaimId } from './document-catalog.js';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const ACTIVE_TASK_STATUSES = ['pending', 'sleeping', 'running', 'needs_attention'];
const DOCUMENT_JOBS = ['documents.extract', 'documents.process'];
/** Deletes per transaction, under Firestore's 500-write commit limit. */
const PAGE = 400;
const TASK_LIMIT = 50;

/**
 * Document deletion on Firestore. PostgreSQL deletes everything in one
 * transaction; here the document's jobs are cancelled first so no chunk lands
 * afterwards, the chunks go in bounded pages, and the catalog record, file row
 * and deduplication claim are removed together last, so a half-finished
 * delete leaves a visible document that a retry completes.
 */
export class FirestoreDocumentDeletionRepository implements DocumentDeletionRepository {
  readonly kind = 'document-deletion-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async purge(
    agentId: string,
    documentId: string,
  ): Promise<{ deleted: boolean; workspacePaths: string[] }> {
    if (agentId !== this.configuredAgentId)
      throw new Error('Document deletion is outside the configured owner');
    const documentRef = this.store.doc('documents', documentId);
    const snapshot = await documentRef.get();
    if (!snapshot.exists) return { deleted: false, workspacePaths: [] };
    const document = decodeRecord<Records['documents']>(snapshot.data());
    if (document.agentId !== agentId || document.id !== documentId)
      return { deleted: false, workspacePaths: [] };

    const jobs = await this.store
      .collection('tasks')
      .where('agentId', '==', agentId)
      .where('trigger.payload.documentId', '==', documentId)
      .limit(TASK_LIMIT + 1)
      .get();
    if (jobs.size > TASK_LIMIT) throw new Error('Document tasks exceed the deletion bound');
    await this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      const fresh = jobs.docs.length ? await tx.getAll(...jobs.docs.map((doc) => doc.ref)) : [];
      const now = this.store.now();
      for (const task of fresh) {
        const job = task.get('trigger')?.payload?.job;
        if (
          task.exists &&
          DOCUMENT_JOBS.includes(job) &&
          ACTIVE_TASK_STATUSES.includes(String(task.get('status')))
        )
          tx.update(task.ref, {
            status: 'cancelled',
            lockedUntil: null,
            runAfter: null,
            leaseToken: null,
            updatedAt: now,
          });
      }
    });

    for (;;) {
      const page = this.store
        .collection('documentChunks')
        .where('documentId', '==', documentId)
        .limit(PAGE);
      const removed = await this.store.db.runTransaction(async (tx) => {
        await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
        const rows = await tx.get(page);
        for (const doc of rows.docs)
          if (doc.get('agentId') === agentId || doc.get('agentId') === undefined)
            tx.delete(doc.ref);
        return rows.size;
      });
      if (removed < PAGE) break;
    }

    const fileRef = this.store.doc('files', document.fileId);
    const claimRef = this.store.doc('documentDedupKeys', dedupClaimId(agentId, document.sha256));
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      const [current, file, claim] = await tx.getAll(documentRef, fileRef, claimRef);
      if (!current?.exists || current.get('agentId') !== agentId)
        return { deleted: false, workspacePaths: [] };
      const paths: string[] = [];
      if (file?.exists && file.get('agentId') === agentId) {
        const path = file.get('workspacePath');
        if (typeof path === 'string' && path) paths.push(path);
        tx.delete(file.ref);
      }
      const processed = current.get('processedTextPath');
      if (typeof processed === 'string' && processed) paths.push(processed);
      // A claim that points here would make a re-upload find a stale claim.
      if (claim?.exists && claim.get('documentId') === documentId) tx.delete(claim.ref);
      if (documentKey(documentId) === current.id) tx.delete(current.ref);
      return { deleted: true, workspacePaths: paths };
    });
  }
}
