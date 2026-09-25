import {
  type CommitmentMaintenanceRepository,
  commitmentIsStale,
  type Records,
} from '@assistant/persistence';
import type { QueryDocumentSnapshot } from '@google-cloud/firestore';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

type Commitment = Records['commitments'];

const PAGE = 200;
/** Live loops for one owner; far above what the desk ever holds. */
const SCAN_LIMIT = 10_000;

/**
 * The open-loop sweep on Firestore. Candidates are the owner's open and
 * snoozed loops; each retirement rechecks the row inside its own transaction,
 * so an owner resolving, snoozing, or editing a loop mid-sweep always wins.
 */
export class FirestoreCommitmentMaintenanceRepository implements CommitmentMaintenanceRepository {
  readonly kind = 'commitment-maintenance-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async markStale(agentId: string, now: Date): Promise<number> {
    if (!agentId) throw new Error('Commitment sweep requires an agent');
    const candidates: string[] = [];
    let scanned = 0;
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = this.store
        .collection('commitments')
        .where('agentId', '==', agentId)
        .where('status', 'in', ['open', 'snoozed'])
        .orderBy('updatedAt', 'desc')
        .limit(PAGE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        const row = decodeRecord<Commitment>(doc.data());
        if (
          row.agentId === agentId &&
          documentKey(row.id) === doc.id &&
          commitmentIsStale(row, now)
        )
          candidates.push(row.id);
      }
      scanned += page.size;
      if (page.size < PAGE) break;
      // Fail loudly rather than silently leaving part of the desk unswept.
      if (scanned >= SCAN_LIMIT) throw new Error('Commitment sweep exceeded its scan bound');
      cursor = page.docs.at(-1);
    }

    let retired = 0;
    for (const id of candidates) {
      const ref = this.store.doc('commitments', id);
      const changed = await this.store.db.runTransaction(async (tx) => {
        await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) return false;
        const row = decodeRecord<Commitment>(snapshot.data());
        if (row.agentId !== agentId || !commitmentIsStale(row, now)) return false;
        tx.update(ref, { status: 'stale', updatedAt: now });
        return true;
      });
      if (changed) retired++;
    }
    return retired;
  }
}
