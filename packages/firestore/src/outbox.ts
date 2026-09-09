import { createHash, randomUUID } from 'node:crypto';
import type { Transaction } from '@google-cloud/firestore';
import { decodeRecord, type InstallationStore } from './store.js';

export interface WakeIntent {
  id: string;
  taskId: string;
  generation: number;
  availableAt: Date;
  status: 'pending' | 'leased' | 'delivered';
  attempts: number;
  leaseToken: string | null;
  lockedUntil: Date | null;
}
export type OutboxLease = WakeIntent & { status: 'leased'; leaseToken: string; lockedUntil: Date };

export function wakeIntentId(taskId: string, generation: number): string {
  if (!taskId || !Number.isSafeInteger(generation) || generation < 0)
    throw new Error('Invalid queue intent');
  return createHash('sha256')
    .update(JSON.stringify([taskId, generation]))
    .digest('hex');
}

/** Use in the SAME transaction as the state transition. No network side effects. */
export function createWakeIntent(
  tx: Transaction,
  store: InstallationStore,
  input: {
    taskId: string;
    generation: number;
    availableAt: Date;
  },
): void {
  if (!Number.isFinite(input.availableAt.getTime())) throw new Error('Invalid queue schedule');
  const id = wakeIntentId(input.taskId, input.generation);
  tx.create(store.doc('outbox', id), {
    ...input,
    id,
    status: 'pending',
    attempts: 0,
    leaseToken: null,
    lockedUntil: null,
    createdAt: store.now(),
  });
}

/**
 * Cloud Tasks dispatch is at-least-once. The intent ID is the provider task name;
 * AlreadyExists counts as dispatch success. Executor generation/lease checks remain mandatory.
 */
export class FirestoreOutbox {
  constructor(readonly store: InstallationStore) {}

  async due(batch = 50): Promise<string[]> {
    if (!Number.isInteger(batch) || batch < 1 || batch > 200)
      throw new Error('Invalid outbox batch');
    const result = await this.store
      .collection('outbox')
      .where('status', 'in', ['pending', 'leased'])
      .where('availableAt', '<=', this.store.now())
      .orderBy('availableAt')
      .limit(batch)
      .get();
    return result.docs.map((doc) => String(doc.get('id')));
  }

  async claim(id: string): Promise<OutboxLease | null> {
    return this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('outbox', id);
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const row = decodeRecord<WakeIntent>(snap.data());
      const now = this.store.now();
      if (
        row.status === 'delivered' ||
        row.availableAt > now ||
        (row.lockedUntil && row.lockedUntil > now)
      )
        return null;
      const lockedUntil = new Date(now.getTime() + 60_000);
      const lease: OutboxLease = {
        ...row,
        status: 'leased',
        leaseToken: randomUUID(),
        lockedUntil,
        availableAt: lockedUntil,
        attempts: row.attempts + 1,
      };
      tx.update(ref, { ...lease });
      return lease;
    });
  }

  private async settle(lease: OutboxLease, delivered: boolean): Promise<boolean> {
    return this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('outbox', lease.id);
      const snap = await tx.get(ref);
      const now = this.store.now();
      if (!snap.exists) return false;
      const row = decodeRecord<WakeIntent>(snap.data());
      if (
        row.status !== 'leased' ||
        row.leaseToken !== lease.leaseToken ||
        !row.lockedUntil ||
        row.lockedUntil <= now
      )
        return false;
      // Failed dispatch retries with bounded exponential backoff. Pending records are
      // durable and never expire through TTL; alerts/repair can inspect attempts.
      tx.update(ref, {
        status: delivered ? 'delivered' : 'pending',
        leaseToken: null,
        lockedUntil: null,
        ...(delivered
          ? { deliveredAt: now }
          : {
              availableAt: new Date(
                now.getTime() + Math.min(300_000, 1000 * 2 ** Math.min(row.attempts, 9)),
              ),
            }),
      });
      return true;
    });
  }
  acknowledge(lease: OutboxLease): Promise<boolean> {
    return this.settle(lease, true);
  }
  retry(lease: OutboxLease): Promise<boolean> {
    return this.settle(lease, false);
  }
}
