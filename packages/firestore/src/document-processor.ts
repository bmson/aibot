import type {
  DocumentProcessorRecordOutcome,
  DocumentProcessorRepository,
  ProcessableDocument,
  Records,
} from '@assistant/persistence';
import type { DocumentSnapshot } from '@google-cloud/firestore';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type DocumentRow = Records['documents'];

/** Pending heavy-format documents one owner has at once; the sweep reads at most this many. */
const PENDING_SCAN = 200;

function owned(snapshot: DocumentSnapshot, agentId: string): DocumentRow | null {
  if (!snapshot.exists) return null;
  const row = decodeRecord<DocumentRow>(snapshot.data());
  return typeof row.id === 'string' &&
    documentKey(row.id) === snapshot.id &&
    row.agentId === agentId
    ? row
    : null;
}

function isClaimable(row: DocumentRow, staleBefore: Date): boolean {
  return (
    row.extractor === 'pending_processor' &&
    row.status === 'pending' &&
    (!(row.processorStartedAt instanceof Date) || row.processorStartedAt < staleBefore)
  );
}

/**
 * The document processor lifecycle on Firestore. Every claim, release, and
 * callback rereads the document in its transaction, so overlapping sweeps and
 * a replayed callback resolve exactly as the PostgreSQL row updates do.
 */
export class FirestoreDocumentProcessorRepository implements DocumentProcessorRepository {
  readonly kind = 'document-processor-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {}

  private pending() {
    return this.store
      .collection('documents')
      .where('agentId', '==', this.agentId)
      .where('extractor', '==', 'pending_processor')
      .where('status', '==', 'pending')
      .limit(PENDING_SCAN);
  }

  async retireExhausted(maxAttempts: number, now: Date): Promise<number> {
    const candidates = await this.pending().get();
    let retired = 0;
    for (const doc of candidates.docs) {
      const moved = await this.store.db.runTransaction(async (tx) => {
        const row = owned(await tx.get(doc.ref), this.agentId);
        if (
          !row ||
          row.extractor !== 'pending_processor' ||
          row.status !== 'pending' ||
          row.processorAttempts < maxAttempts
        )
          return false;
        tx.update(
          doc.ref,
          encodeRecord({
            status: 'failed',
            processorTokenHash: null,
            error: `processor did not report back after ${maxAttempts} launches`,
            updatedAt: now,
          }),
        );
        return true;
      });
      if (moved) retired += 1;
    }
    return retired;
  }

  async claimable(input: {
    documentId?: string;
    staleBefore: Date;
    limit: number;
  }): Promise<ProcessableDocument[]> {
    const rows = input.documentId
      ? [owned(await this.store.doc('documents', input.documentId).get(), this.agentId)]
      : (await this.pending().get()).docs.map((doc) => owned(doc, this.agentId));
    const selected = rows
      .filter((row): row is DocumentRow => row !== null && isClaimable(row, input.staleBefore))
      .slice(0, input.limit);
    if (selected.length === 0) return [];
    const files = await this.store.db.getAll(
      ...selected.map((row) => this.store.doc('files', row.fileId)),
    );
    return selected.flatMap((row, i) => {
      const file = files[i];
      const workspacePath = file?.exists ? file.get('workspacePath') : null;
      if (typeof workspacePath !== 'string' || file?.get('agentId') !== this.agentId) return [];
      return [
        {
          id: row.id,
          agentId: row.agentId,
          title: row.title,
          mime: row.mime,
          extractor: row.extractor,
          workspacePath,
        },
      ];
    });
  }

  async claim(
    id: string,
    input: { tokenHash: string; now: Date; staleBefore: Date },
  ): Promise<boolean> {
    const ref = this.store.doc('documents', id);
    return this.store.db.runTransaction(async (tx) => {
      const erasure = await tx.get(this.store.doc('privacyErasureJobs', this.agentId));
      if (erasure.exists && privacyErasureIsActive(erasure.get('status'))) return false;
      const row = owned(await tx.get(ref), this.agentId);
      if (!row || !isClaimable(row, input.staleBefore)) return false;
      tx.update(
        ref,
        encodeRecord({
          processorTokenHash: input.tokenHash,
          processorStartedAt: input.now,
          processorAttempts: row.processorAttempts + 1,
          updatedAt: input.now,
        }),
      );
      return true;
    });
  }

  async release(id: string, now: Date): Promise<void> {
    const ref = this.store.doc('documents', id);
    await this.store.db.runTransaction(async (tx) => {
      if (!owned(await tx.get(ref), this.agentId)) return;
      tx.update(
        ref,
        encodeRecord({ processorTokenHash: null, processorStartedAt: null, updatedAt: now }),
      );
    });
  }

  async recordResult(
    input: Parameters<DocumentProcessorRepository['recordResult']>[0],
  ): Promise<DocumentProcessorRecordOutcome> {
    const ref = this.store.doc('documents', input.documentId);
    return this.store.db.runTransaction(async (tx) => {
      const row = owned(await tx.get(ref), this.agentId);
      if (!row) return { ok: false, status: 404, error: 'document not found' };
      if (!row.processorTokenHash)
        return { ok: false, status: 409, error: 'no pending processor run' };
      if (!input.tokenMatches(row.processorTokenHash))
        return { ok: false, status: 403, error: 'invalid token' };
      if (input.ok) {
        tx.update(
          ref,
          encodeRecord({
            processedTextPath: input.processedTextPath,
            processorTokenHash: null,
            error: null,
            updatedAt: input.now,
          }),
        );
        return { ok: true, documentId: row.id, agentId: row.agentId, extract: true };
      }
      tx.update(
        ref,
        encodeRecord({
          status: input.unsupported ? 'unsupported' : 'failed',
          processorTokenHash: null,
          error: input.error.slice(0, 2000),
          updatedAt: input.now,
        }),
      );
      return { ok: true, documentId: row.id, agentId: row.agentId, extract: false };
    });
  }
}
