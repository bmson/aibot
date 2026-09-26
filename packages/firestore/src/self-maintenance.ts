import { createHash } from 'node:crypto';
import type {
  NewSelfMaintenanceItem,
  OpenImprovementProposal,
  Records,
  SelfMaintenanceRepository,
} from '@assistant/persistence';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { documentKey, encodeRecord, type InstallationStore } from './store.js';

/** A stable UUID per (owner, title), so a re-run converges on the same document. */
function itemIdFor(agentId: string, title: string): string {
  const hex = createHash('sha256')
    .update(JSON.stringify([agentId, title]))
    .digest('hex');
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The self-maintenance backlog on Firestore. Items are unique per owner and
 * title like the PostgreSQL constraint; imported rows are found by query
 * before any insert.
 */
export class FirestoreSelfMaintenanceRepository implements SelfMaintenanceRepository {
  readonly kind = 'self-maintenance-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {}

  private owned(agentId: string): void {
    if (agentId !== this.agentId)
      throw new Error('Self-maintenance is outside the configured owner');
  }

  async openProposals(agentId: string, limit: number): Promise<OpenImprovementProposal[]> {
    this.owned(agentId);
    const snapshot = await this.store
      .collection('improvementProposals')
      .where('agentId', '==', agentId)
      .where('status', '==', 'open')
      .select('id', 'kind', 'title', 'rationale')
      .limit(limit)
      .get();
    return snapshot.docs.flatMap((doc) => {
      const id = doc.get('id');
      const kind = doc.get('kind');
      const title = doc.get('title');
      const rationale = doc.get('rationale');
      return typeof id === 'string' &&
        documentKey(id) === doc.id &&
        typeof kind === 'string' &&
        typeof title === 'string' &&
        typeof rationale === 'string'
        ? [{ id, kind, title, rationale }]
        : [];
    });
  }

  async insert(agentId: string, item: NewSelfMaintenanceItem): Promise<boolean> {
    this.owned(agentId);
    const id = itemIdFor(agentId, item.title);
    const ref = this.store.doc('selfMaintenance', id);
    const imported = this.store
      .collection('selfMaintenance')
      .where('agentId', '==', agentId)
      .where('title', '==', item.title)
      .limit(1);
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      const [byId, byTitle] = await Promise.all([tx.get(ref), tx.get(imported)]);
      if (byId.exists || !byTitle.empty) return false;
      const now = this.store.now();
      const row: Records['selfMaintenance'] = {
        id,
        agentId,
        title: item.title,
        diagnosis: item.diagnosis,
        targetArea: item.targetArea,
        status: item.status,
        blockedReason: item.blockedReason,
        proposalId: null,
        prNumber: null,
        prUrl: null,
        createdAt: now,
        updatedAt: now,
      };
      tx.create(ref, encodeRecord(row));
      return true;
    });
  }
}
