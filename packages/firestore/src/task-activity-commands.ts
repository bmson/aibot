import type { TaskActivityCommandRepository } from '@assistant/persistence';
import {
  type DocumentReference,
  type DocumentSnapshot,
  FieldPath,
  type QueryDocumentSnapshot,
  type Transaction,
} from '@google-cloud/firestore';
import { createWakeIntent } from './outbox.js';
import {
  assertPrivacyErasureFenceUnchanged,
  privacyErasureIsActive,
  readPrivacyErasureFence,
} from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const PAGE_SIZE = 250;
const MAX_OWNER_TASKS = 25_000;
const MAX_ARCHIVE_OLD_WRITES = 400;

function isTerminalArchiveCandidate(
  document: DocumentSnapshot | QueryDocumentSnapshot,
  agentId: string,
  cutoff: Date,
): boolean {
  const data = document.data();
  if (!document.exists || !data) return false;
  const task = decodeRecord<Record<string, unknown>>(data);
  if (
    task.agentId !== agentId ||
    typeof task.id !== 'string' ||
    documentKey(task.id) !== document.id ||
    typeof task.status !== 'string' ||
    !(
      task.archivedAt === null ||
      (task.archivedAt instanceof Date && Number.isFinite(task.archivedAt.getTime()))
    ) ||
    !(task.updatedAt instanceof Date) ||
    !Number.isFinite(task.updatedAt.getTime())
  )
    throw new Error('Invalid owner activity task');
  return (
    task.archivedAt === null &&
    TERMINAL.has(task.status) &&
    task.updatedAt.getTime() < cutoff.getTime()
  );
}

/** Archives or restores one owned task in the same transaction as its safety checks. */
export class FirestoreTaskActivityCommandRepository implements TaskActivityCommandRepository {
  readonly kind = 'task-activity-command-repository' as const;

  constructor(readonly store: InstallationStore) {}

  archive(agentId: string, taskId: string): Promise<void> {
    return this.change(agentId, taskId, 'archive');
  }

  restore(agentId: string, taskId: string): Promise<void> {
    return this.change(agentId, taskId, 'restore');
  }

  revokeAutonomy(agentId: string, taskId: string): Promise<void> {
    return this.changeOwnerTask(
      agentId,
      taskId,
      (task, ref, tx) => {
        const grant = task.autonomyGrant;
        if (grant === null || grant === undefined) return;
        if (typeof grant !== 'object' || Array.isArray(grant))
          throw new Error('Invalid task autonomy grant');
        const current = grant as Record<string, unknown>;
        if (current.revokedAt) return;
        const now = this.store.now();
        tx.update(ref, {
          autonomyGrant: { ...current, revokedAt: now.toISOString() },
          updatedAt: now,
        });
      },
      true,
    );
  }

  async raiseBudget(agentId: string, taskId: string, limit: number): Promise<void> {
    if (!Number.isFinite(limit) || limit < 0.01 || limit > 10_000)
      throw new Error('task budget must be between $0.01 and $10,000');
    await this.changeOwnerTask(agentId, taskId, (task, ref, tx) => {
      if (task.status !== 'needs_attention') throw new Error('only stalled tasks can be retried');
      const currentLimit = Number(task.budgetUsdLimit);
      const spent = Number(task.spentUsd);
      if (
        !Number.isFinite(currentLimit) ||
        !Number.isFinite(spent) ||
        limit <= currentLimit ||
        limit < spent
      )
        throw new Error('new task budget must be above its current cap and spend');
      if (!Number.isSafeInteger(task.queueGeneration) || Number(task.queueGeneration) < 0)
        throw new Error('Invalid activity task');

      const now = this.store.now();
      const generation = Number(task.queueGeneration) + 1;
      const state =
        task.state && typeof task.state === 'object' && !Array.isArray(task.state)
          ? { ...(task.state as Record<string, unknown>) }
          : task.state;
      if (state && typeof state === 'object' && !Array.isArray(state))
        delete (state as Record<string, unknown>).pendingFinal;
      const statePatch = state === undefined ? {} : { state };
      tx.update(ref, {
        status: 'pending',
        budgetUsdLimit: limit.toFixed(4),
        ...statePatch,
        runAfter: null,
        lockedUntil: null,
        queueGeneration: generation,
        attempt: 0,
        attentionNotifiedAt: null,
        updatedAt: now,
      });
      createWakeIntent(tx, this.store, { taskId, generation, availableAt: now });
    });
  }

  async archiveOld(agentId: string, olderThanDays = 30): Promise<void> {
    if (!agentId || !Number.isFinite(olderThanDays) || olderThanDays <= 0)
      throw new Error('Invalid archive-old activity request');
    const cutoff = new Date(this.store.now().getTime() - olderThanDays * 24 * 60 * 60 * 1000);
    const agents = await this.store.collection('agents').limit(2).get();
    const agent = agents.docs[0];
    if (
      agents.size !== 1 ||
      !agent ||
      agent.id !== documentKey(agentId) ||
      agent.get('id') !== agentId
    )
      throw new Error('Activity requires one matching configured agent');
    const fence = await readPrivacyErasureFence(this.store, agentId);

    const candidates: QueryDocumentSnapshot[] = [];
    let scanned = 0;
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = this.store
        .collection('tasks')
        .where('agentId', '==', agentId)
        .select('id', 'agentId', 'status', 'archivedAt', 'updatedAt')
        .orderBy(FieldPath.documentId())
        .limit(PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      scanned += page.size;
      if (scanned > MAX_OWNER_TASKS)
        throw new Error('Owner activity exceeds the bounded task scan');
      for (const document of page.docs) {
        if (isTerminalArchiveCandidate(document, agentId, cutoff)) candidates.push(document);
      }
      if (candidates.length > MAX_ARCHIVE_OLD_WRITES)
        throw new Error('Archive-old activity exceeds the bounded write limit');
      if (page.size < PAGE_SIZE) break;
      cursor = page.docs.at(-1);
    }
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    if (candidates.length === 0) return;

    const now = this.store.now();
    await this.store.db.runTransaction(async (tx) => {
      const ownerQuery = await tx.get(this.store.collection('agents').limit(2));
      const owner = ownerQuery.docs[0];
      if (
        ownerQuery.size !== 1 ||
        !owner ||
        owner.id !== documentKey(agentId) ||
        owner.get('id') !== agentId
      )
        throw new Error('Activity requires one matching configured agent');
      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime)
      )
        throw new Error('Privacy erasure is in progress');
      const current = await Promise.all(candidates.map((document) => tx.get(document.ref)));
      for (let index = 0; index < current.length; index += 1) {
        const snapshot = current[index];
        const candidate = candidates[index];
        if (!snapshot?.exists || !candidate) continue;
        if (isTerminalArchiveCandidate(snapshot, agentId, cutoff)) {
          tx.update(snapshot.ref, { archivedAt: now, updatedAt: now });
        }
      }
    });
  }

  private async change(
    agentId: string,
    taskId: string,
    action: 'archive' | 'restore',
  ): Promise<void> {
    if (!agentId || !taskId) throw new Error('Activity agent and task are required');
    await this.store.db.runTransaction(async (tx) => {
      const agents = await tx.get(this.store.collection('agents').limit(2));
      const agent = agents.docs[0];
      if (
        agents.size !== 1 ||
        !agent ||
        agent.id !== documentKey(agentId) ||
        agent.get('id') !== agentId
      )
        throw new Error('Activity requires one matching configured agent');

      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime)
      )
        throw new Error('Privacy erasure is in progress');

      const ref = this.store.doc('tasks', taskId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) throw new Error('activity item not found');
      const task = decodeRecord<Record<string, unknown>>(snapshot.data());
      if (task.agentId !== agentId) throw new Error('activity item not found');
      if (
        task.id !== taskId ||
        documentKey(taskId) !== snapshot.id ||
        typeof task.status !== 'string' ||
        !(
          task.archivedAt === null ||
          (task.archivedAt instanceof Date && Number.isFinite(task.archivedAt.getTime()))
        )
      )
        throw new Error('Invalid activity task');

      if (action === 'archive') {
        if (!TERMINAL.has(task.status))
          throw new Error('only completed, failed, or cancelled activity can be archived');
        // PostgreSQL leaves an already-archived task unchanged.
        if (task.archivedAt !== null) return;
      }
      const now = this.store.now();
      tx.update(ref, { archivedAt: action === 'archive' ? now : null, updatedAt: now });
    });
  }

  private async changeOwnerTask(
    agentId: string,
    taskId: string,
    update: (task: Record<string, unknown>, ref: DocumentReference, tx: Transaction) => void,
    ignoreMissing = false,
  ): Promise<void> {
    if (!agentId || !taskId) throw new Error('Activity agent and task are required');
    await this.store.db.runTransaction(async (tx) => {
      const agents = await tx.get(this.store.collection('agents').limit(2));
      const agent = agents.docs[0];
      if (
        agents.size !== 1 ||
        !agent ||
        agent.id !== documentKey(agentId) ||
        agent.get('id') !== agentId
      )
        throw new Error('Activity requires one matching configured agent');

      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime)
      )
        throw new Error('Privacy erasure is in progress');

      const ref = this.store.doc('tasks', taskId);
      const snapshot = await tx.get(ref);
      // PostgreSQL autonomy revocation treats an absent or foreign row as a no-op.
      // Budget increases report a missing owner-scoped activity item.
      if (!snapshot.exists || snapshot.get('agentId') !== agentId) {
        if (ignoreMissing) return;
        throw new Error('activity item not found');
      }
      const task = decodeRecord<Record<string, unknown>>(snapshot.data());
      if (task.id !== taskId || documentKey(taskId) !== snapshot.id)
        throw new Error('Invalid activity task');
      update(task, ref, tx);
    });
  }
}
