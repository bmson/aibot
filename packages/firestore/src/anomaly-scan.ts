import { createHash } from 'node:crypto';
import type {
  AnomalyScanRepository,
  AutoExecution,
  NewAnomaly,
  Records,
} from '@assistant/persistence';
import type { QueryDocumentSnapshot } from '@google-cloud/firestore';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const PAGE = 500;
/** Auto-executions read across the eight-day baseline; far above any real policy volume. */
const AUTO_EXEC_LIMIT = 20_000;

/** A stable UUID per anomaly identity, so a re-scan converges on the same document. */
function anomalyIdFor(agentId: string, anomaly: NewAnomaly): string {
  const hex = createHash('sha256')
    .update(JSON.stringify([agentId, anomaly.kind, anomaly.subjectKey, anomaly.windowLabel]))
    .digest('hex');
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The approval-anomaly scan on Firestore. Tool calls are scoped by the
 * policy that allowed them, which belongs to one owner; anomalies are keyed by
 * their identity, imported ones are found by query before any insert, and no
 * anomaly is written while a privacy erasure is active.
 */
export class FirestoreAnomalyScanRepository implements AnomalyScanRepository {
  readonly kind = 'anomaly-scan-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {}

  private owned(agentId: string): void {
    if (agentId !== this.agentId) throw new Error('Anomaly scan is outside the configured owner');
  }

  async policies(agentId: string): Promise<Array<{ id: string; toolName: string }>> {
    this.owned(agentId);
    const snapshot = await this.store
      .collection('approvalPolicies')
      .where('agentId', '==', agentId)
      .get();
    return snapshot.docs.flatMap((doc) => {
      const id = doc.get('id');
      const toolName = doc.get('toolName');
      return typeof id === 'string' && documentKey(id) === doc.id && typeof toolName === 'string'
        ? [{ id, toolName }]
        : [];
    });
  }

  async autoExecutions(
    agentId: string,
    since: Date,
    policyIds: string[],
  ): Promise<AutoExecution[]> {
    this.owned(agentId);
    const allowed = new Set(policyIds);
    const rows: AutoExecution[] = [];
    let scanned = 0;
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = this.store
        .collection('toolCalls')
        .where('risk', '==', 'autonomous')
        .where('status', 'in', ['succeeded', 'executing'])
        .where('createdAt', '>=', since)
        .orderBy('createdAt', 'asc')
        .limit(PAGE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        const row = decodeRecord<Records['toolCalls']>(doc.data());
        const policyId = (row.decision as { policyId?: unknown } | null)?.policyId;
        if (
          typeof row.id === 'string' &&
          typeof policyId === 'string' &&
          allowed.has(policyId) &&
          row.createdAt instanceof Date
        )
          rows.push({ id: row.id, toolName: row.toolName, policyId, createdAt: row.createdAt });
      }
      scanned += page.size;
      if (page.size < PAGE) return rows;
      if (scanned >= AUTO_EXEC_LIMIT) throw new Error('Auto-execution scan exceeded bound');
      cursor = page.docs[page.docs.length - 1];
    }
  }

  async dismissedFrequency(
    agentId: string,
  ): Promise<Array<{ policyId: string; observed: number }>> {
    this.owned(agentId);
    const snapshot = await this.store
      .collection('anomalies')
      .where('agentId', '==', agentId)
      .where('kind', '==', 'frequency')
      .where('status', '==', 'dismissed')
      .get();
    return snapshot.docs.flatMap((doc) => {
      const policyId = doc.get('policyId');
      const observed = doc.get('observed');
      return typeof policyId === 'string' && typeof observed === 'number'
        ? [{ policyId, observed }]
        : [];
    });
  }

  async insert(agentId: string, anomalies: NewAnomaly[]): Promise<Records['anomalies'][]> {
    this.owned(agentId);
    const inserted: Records['anomalies'][] = [];
    for (const anomaly of anomalies) {
      const id = anomalyIdFor(agentId, anomaly);
      const ref = this.store.doc('anomalies', id);
      const imported = this.store
        .collection('anomalies')
        .where('agentId', '==', agentId)
        .where('kind', '==', anomaly.kind)
        .where('subjectKey', '==', anomaly.subjectKey)
        .where('windowLabel', '==', anomaly.windowLabel)
        .limit(1);
      const created = await this.store.db.runTransaction(async (tx) => {
        await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
        const [byId, byIdentity] = await Promise.all([tx.get(ref), tx.get(imported)]);
        if (byId.exists || !byIdentity.empty) return null;
        const now = this.store.now();
        const row: Records['anomalies'] = {
          ...anomaly,
          id,
          createdAt: now,
          updatedAt: now,
          agentId,
          status: 'open',
        };
        tx.create(ref, encodeRecord(row));
        return row;
      });
      if (created) inserted.push(created);
    }
    return inserted;
  }
}
