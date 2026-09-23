import { randomUUID } from 'node:crypto';
import { taskFixture } from '@assistant/persistence/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreShellStatusRepository } from './shell-status.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore shell status', () => {
  let store: InstallationStore;
  let repository: FirestoreShellStatusRepository;
  const now = new Date('2026-09-22T12:00:00Z');

  beforeEach(async () => {
    store = emulatorStore(() => now);
    repository = new FirestoreShellStatusRepository(store);
    await store.doc('agents', 'owner').set({ id: 'owner' });

    const task = (id: string, agentId: string, status: string) => ({
      ...taskFixture({ id, agentId, conversationId: `conversation-${id}`, reminderId: '' }),
      status,
    });
    const ownRunning = task('own-running', 'owner', 'running');
    const ownAttention = task('own-attention', 'owner', 'needs_attention');
    const foreignAttention = task('foreign-attention', 'other', 'needs_attention');
    const usableOrganizedId = randomUUID();
    const usableNewId = randomUUID();
    const reviewId = randomUUID();
    const expiredId = randomUUID();
    const memory = (id: string, values: Record<string, unknown>) => ({
      id,
      agentId: 'owner',
      category: 'knowledge',
      quarantined: false,
      expiresAt: null,
      createdAt: now,
      content: id,
      kind: 'fact',
      domain: null,
      confidence: '1.00',
      importance: 3,
      ownerConfirmed: false,
      pinned: false,
      lastConsolidatedAt: null,
      originTrust: 'owner',
      sourceTaskId: null,
      validFrom: null,
      validUntil: null,
      ...values,
    });
    const batch = store.db.batch();
    for (const row of [ownRunning, ownAttention, foreignAttention])
      batch.set(store.doc('tasks', row.id), row);
    batch.set(
      store.doc('memories', usableOrganizedId),
      memory(usableOrganizedId, { ownerConfirmed: true, lastConsolidatedAt: now }),
    );
    batch.set(store.doc('memories', usableNewId), memory(usableNewId, {}));
    batch.set(
      store.doc('memories', reviewId),
      memory(reviewId, { quarantined: true, ownerConfirmed: false }),
    );
    batch.set(
      store.doc('memories', expiredId),
      memory(expiredId, { quarantined: true, expiresAt: new Date(now.getTime() - 1) }),
    );
    const approval = (id: string, taskId: string, expiresAt: Date, status = 'pending') =>
      batch.set(store.doc('approvals', id), { id, taskId, expiresAt, status });
    approval('current-owner', ownRunning.id, new Date(now.getTime() + 60_000));
    approval('expired-owner', ownAttention.id, new Date(now.getTime() - 1));
    approval('current-foreign', foreignAttention.id, new Date(now.getTime() + 60_000));
    approval('resolved-owner', ownRunning.id, new Date(now.getTime() + 60_000), 'approved');
    await batch.commit();
  });

  afterEach(async () => disposeStore(store));

  it('projects exact owner dashboard and memory lifecycle state with presence precedence', async () => {
    await expect(repository.load('owner')).resolves.toEqual({
      dashboard: { pendingApprovals: 1, needsAttention: 1, presence: 'attention' },
      memoryHealth: {
        totalUsable: 2,
        notYetOrganized: 1,
        awaitingReview: 1,
        ownerConfirmed: 1,
        lastOrganizedAt: now,
      },
    });

    await store.doc('tasks', 'own-attention').update({ status: 'running' });
    await store.doc('approvals', 'current-owner').update({ status: 'approved' });
    await expect(repository.load('owner')).resolves.toMatchObject({
      dashboard: { pendingApprovals: 0, needsAttention: 0, presence: 'working' },
    });

    await store.doc('tasks', 'own-running').update({ status: 'done' });
    await store.doc('tasks', 'own-attention').update({ status: 'done' });
    await expect(repository.load('owner')).resolves.toMatchObject({
      dashboard: { pendingApprovals: 0, needsAttention: 0, presence: 'idle' },
    });
  });

  it('rejects reads for an agent other than the configured owner', async () => {
    await expect(repository.load('other')).rejects.toThrow('outside the configured installation');
  });
});
