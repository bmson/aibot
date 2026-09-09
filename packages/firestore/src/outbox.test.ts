import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWakeIntent, FirestoreOutbox, wakeIntentId } from './outbox.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore durable queue intent', () => {
  let store: InstallationStore, outbox: FirestoreOutbox, now: Date;
  beforeEach(() => {
    now = new Date();
    store = emulatorStore(() => now);
    outbox = new FirestoreOutbox(store);
  });
  afterEach(async () => {
    await disposeStore(store);
  });
  async function enqueue() {
    await store.db.runTransaction(async (tx) => {
      tx.set(store.doc('tasks', 'task'), { queueGeneration: 1, status: 'pending' });
      createWakeIntent(tx, store, { taskId: 'task', generation: 1, availableAt: now });
    });
    return wakeIntentId('task', 1);
  }
  it('a failed state transaction leaves neither a task transition nor a dispatch intent', async () => {
    await expect(
      store.db.runTransaction(async (tx) => {
        tx.set(store.doc('tasks', 'task'), { queueGeneration: 1 });
        createWakeIntent(tx, store, { taskId: 'task', generation: 1, availableAt: now });
        throw new Error('crash before commit');
      }),
    ).rejects.toThrow('crash before commit');
    expect(await outbox.due()).toEqual([]);
    expect((await store.doc('tasks', 'task').get()).exists).toBe(false);
  });
  it('recovers a crash after dispatch but before acknowledgement using the same provider ID', async () => {
    const id = await enqueue();
    const old = await outbox.claim(id);
    if (!old) throw new Error('Fixture claim failed');
    expect(await outbox.due()).toEqual([]);
    now = new Date(now.getTime() + 61_000);
    expect(await outbox.due()).toEqual([id]);
    const current = await outbox.claim(id);
    if (!current) throw new Error('Reclaim failed');
    expect(current.id).toBe(old.id);
    expect(await outbox.acknowledge(old)).toBe(false);
    expect(await outbox.acknowledge(current)).toBe(true);
    expect(await outbox.due()).toEqual([]);
  });
  it('one dispatcher owns a lease and transient failure remains retryable', async () => {
    const id = await enqueue();
    const claims = await Promise.all([outbox.claim(id), outbox.claim(id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const lease = claims.find(Boolean);
    if (!lease) throw new Error('Fixture claim failed');
    expect(await outbox.retry(lease)).toBe(true);
    expect(await outbox.due()).toEqual([]);
    now = new Date(now.getTime() + 10_000);
    expect(await outbox.due()).toEqual([id]);
  });
});
