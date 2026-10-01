import { createHash } from 'node:crypto';
import {
  ACTIVE_REPAIR_STATUSES,
  queuedRepairIssues,
  type RepairIssue,
  repairFailureKey,
  repairTransition,
  type SelfRepairRepository,
} from '@assistant/persistence';
import {
  assertPrivacyErasureFenceUnchanged,
  assertPrivacyErasureInactiveInTransaction,
  readPrivacyErasureFence,
} from './privacy-erasure.js';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

export class FirestoreSelfRepairRepository implements SelfRepairRepository {
  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {}
  private owned(agentId: string) {
    if (agentId !== this.agentId) throw new Error('Repair is outside the configured owner');
  }
  async report(agentId: string, input: Parameters<SelfRepairRepository['report']>[1]) {
    this.owned(agentId);
    const hex = createHash('sha256')
      .update(JSON.stringify([agentId, input.fingerprint]))
      .digest('hex');
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    const ref = this.store.doc('selfRepairIssues', id);
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      if (input.sourceTaskId) {
        const task = await tx.get(this.store.doc('tasks', input.sourceTaskId));
        if (!task.exists || task.get('agentId') !== agentId)
          throw new Error('Repair evidence task is outside the owner');
      }
      if (input.conversationId) {
        const chat = await tx.get(this.store.doc('conversations', input.conversationId));
        if (!chat.exists || chat.get('agentId') !== agentId)
          throw new Error('Repair conversation is outside the owner');
      }
      const previous = await tx.get(ref);
      if (previous.exists) return decodeRecord<RepairIssue>(previous.data());
      const now = this.store.now();
      const row: RepairIssue = {
        id,
        agentId,
        fingerprint: input.fingerprint,
        status: 'reported',
        version: 0,
        data: { ...input, history: [{ status: 'reported', at: now.toISOString(), detail: '' }] },
        createdAt: now,
        updatedAt: now,
      };
      tx.create(ref, encodeRecord(row));
      return row;
    });
  }
  async list(agentId: string) {
    this.owned(agentId);
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const snapshot = await this.store
      .collection('selfRepairIssues')
      .where('agentId', '==', agentId)
      .limit(1001)
      .get();
    if (snapshot.size > 1000) throw new Error('Repair ledger requires archival');
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return snapshot.docs
      .map((doc) => decodeRecord<RepairIssue>(doc.data()))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  async claim(agentId: string, now: Date, dailyLimit: number) {
    this.owned(agentId);
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      // Every claim writes the same owner document, serializing concurrent sweeps.
      const owner = this.store.doc('agents', agentId);
      const snapshot = await tx.get(
        this.store.collection('selfRepairIssues').where('agentId', '==', agentId).limit(1001),
      );
      const ownerRow = await tx.get(owner);
      if (!ownerRow.exists) throw new Error('Repair owner is missing');
      const rows = snapshot.docs.map((doc) => decodeRecord<RepairIssue>(doc.data()));
      if (rows.length > 1000 || rows.some((row) => ACTIVE_REPAIR_STATUSES.includes(row.status)))
        return null;
      const since = new Date(now.getTime() - 86400000).toISOString();
      if (
        rows.reduce(
          (sum, row) =>
            sum +
            row.data.history.filter((event) => event.status === 'fixing' && event.at >= since)
              .length,
          0,
        ) >= dailyLimit
      )
        return null;
      const issue = queuedRepairIssues(rows)[0];
      if (!issue) return null;
      const next = repairTransition(issue, 'investigating', {}, now);
      tx.update(owner, { updatedAt: now });
      tx.set(this.store.doc('selfRepairIssues', issue.id), encodeRecord(next));
      return next;
    });
  }
  async update(
    issue: RepairIssue,
    status: Parameters<SelfRepairRepository['update']>[1],
    patch: Parameters<SelfRepairRepository['update']>[2],
    now: Date,
  ) {
    this.owned(issue.agentId);
    const ref = this.store.doc('selfRepairIssues', issue.id);
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, issue.agentId);
      const saved = await tx.get(ref);
      if (
        !saved.exists ||
        saved.get('agentId') !== issue.agentId ||
        saved.get('version') !== issue.version
      )
        return null;
      const next = repairTransition(issue, status, patch, now);
      tx.set(ref, encodeRecord(next));
      return next;
    });
  }
  async failures(agentId: string, since: Date) {
    this.owned(agentId);
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const snapshot = await this.store
      .collection('tasks')
      .where('agentId', '==', agentId)
      .where('updatedAt', '>=', since)
      .orderBy('updatedAt', 'desc')
      .limit(100)
      .get();
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return snapshot.docs
      .filter(
        (doc) =>
          ['failed', 'needs_attention'].includes(doc.get('status')) &&
          !String(doc.get('title')).startsWith('self-repair'),
      )
      .slice(0, 20)
      .map((doc) => {
        const row = decodeRecord<{ id: string; title: string; state: unknown; updatedAt: Date }>(
          doc.data(),
        );
        return {
          taskId: row.id,
          title: row.title ?? 'Failed task',
          symptomKey: repairFailureKey(row.title ?? 'Failed task', row.state),
          observedAt: row.updatedAt.toISOString(),
        };
      });
  }
}
