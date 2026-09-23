import { randomUUID } from 'node:crypto';
import { taskFixture } from '@assistant/persistence/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreShellPresenceRepository } from './shell-presence.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore shell presence', () => {
  let store: InstallationStore;
  let repository: FirestoreShellPresenceRepository;
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const now = new Date('2026-09-22T12:00:00Z');

  beforeEach(() => {
    store = emulatorStore(() => now);
    repository = new FirestoreShellPresenceRepository(store, agentId);
  });

  afterEach(async () => disposeStore(store));

  async function addTask(id: string, ownerId: string, status: string) {
    const task = taskFixture({
      id,
      agentId: ownerId,
      conversationId: randomUUID(),
      reminderId: '',
    });
    task.status = status;
    await store.doc('tasks', id).set(task);
  }

  async function addApproval(id: string, taskId: string, expiresAt: Date, status = 'pending') {
    await store.doc('approvals', id).set({ id, taskId, expiresAt, status });
  }

  it('preserves attention precedence and scopes task and approval joins to the configured agent', async () => {
    await addTask('foreign-attention', otherAgentId, 'needs_attention');
    await addApproval('foreign-pending', 'foreign-attention', new Date(now.getTime() + 60_000));
    await addTask('owner-running', agentId, 'running');
    await addTask('owner-waiting', agentId, 'waiting_approval');
    await addApproval('expired-owner', 'owner-waiting', new Date(now.getTime() - 1));
    await addApproval(
      'resolved-owner',
      'owner-waiting',
      new Date(now.getTime() + 60_000),
      'approved',
    );

    await expect(repository.load(agentId)).resolves.toBe('working');

    await addApproval('active-owner', 'owner-waiting', new Date(now.getTime() + 60_000));
    await expect(repository.load(agentId)).resolves.toBe('attention');

    await addTask('owner-needs-attention', agentId, 'needs_attention');
    await expect(repository.load(agentId)).resolves.toBe('attention');
  });

  it('returns idle only after complete bounded probes find no owner activity', async () => {
    await addTask('foreign-running', otherAgentId, 'running');
    await addApproval('expired-foreign', 'foreign-running', new Date(now.getTime() - 1));
    await expect(repository.load(agentId)).resolves.toBe('idle');
  });

  it('fails explicitly when a negative approval result would exceed the probe bound', async () => {
    const batch = store.db.batch();
    for (let index = 0; index < 101; index += 1) {
      const id = `pending-${index}`;
      batch.set(store.doc('approvals', id), {
        id,
        taskId: `foreign-task-${index}`,
        expiresAt: new Date(now.getTime() + 60_000),
        status: 'pending',
      });
    }
    await batch.commit();

    await expect(repository.load(agentId)).rejects.toThrow('exceeds its explicit limit');
  });

  it('rejects a caller outside the configured installation', async () => {
    await expect(repository.load(randomUUID())).rejects.toThrow(
      'outside the configured installation',
    );
  });
});
