import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreAuditInvestigationRepository } from './audit-investigation.js';
import { encodeRecord, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore audit investigation', () => {
  let store: InstallationStore;
  const owner = randomUUID();
  const taskId = randomUUID();
  const conversationId = randomUUID();
  const at = new Date('2026-09-30T01:00:00Z');
  beforeEach(async () => {
    store = emulatorStore();
    await store.doc('tasks', taskId).set(
      encodeRecord({
        id: taskId,
        agentId: owner,
        createdAt: at,
        conversationId,
        leaseToken: 'do-not-return',
        state: { callbackToken: 'private-runtime' },
      }),
    );
    await store.doc('conversations', conversationId).set({ id: conversationId, agentId: owner });
  });
  afterEach(async () => disposeStore(store));
  it('scopes every entry and continuation, excludes unrelated data, and pages equal timestamps', async () => {
    const repo = new FirestoreAuditInvestigationRepository(store);
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort().reverse();
    for (const id of ids)
      await store.doc('modelCallAudit', id).set({
        id,
        taskId,
        createdAt: at,
        input: 'original prompt',
        output: 'provider error',
        capture: 'redacted',
      });
    expect(await repo.task('other-owner', taskId)).toBeNull();
    expect(await repo.read('other-owner', taskId, { section: 'modelCallAudit', limit: 2 })).toEqual(
      [],
    );
    expect(await repo.task(owner, taskId)).not.toHaveProperty('leaseToken');
    const first = await repo.read(owner, taskId, { section: 'modelCallAudit', limit: 2 });
    const next = await repo.read(owner, taskId, {
      section: 'modelCallAudit',
      limit: 2,
      cursor: { at, id: ids[1] as string },
    });
    expect([...first, ...next].map((row) => row.id)).toEqual(ids);
    expect(first[0]?.data.input).toBe('original prompt');
    const otherId = randomUUID();
    await store
      .doc('modelCallAudit', otherId)
      .set({ id: otherId, taskId: randomUUID(), createdAt: at, input: 'other-task' });
    expect(
      await repo.read(owner, taskId, { section: 'modelCallAudit', limit: 1, entryId: otherId }),
    ).toEqual([]);
  });
  it('returns conversation context from task creation, excluding future and other conversations', async () => {
    for (const [text, createdAt] of [
      ['before', new Date(at.getTime() - 1000)],
      ['after', new Date(at.getTime() + 1000)],
    ] as const) {
      const id = randomUUID();
      await store.doc('messages', id).set({ id, conversationId, createdAt, text, role: 'user' });
    }
    const rows = await new FirestoreAuditInvestigationRepository(store).read(owner, taskId, {
      section: 'contextMessages',
      limit: 10,
    });
    expect(rows.map((row) => row.data.text)).toEqual(['before']);
    await store.doc('conversations', conversationId).update({ agentId: 'someone-else' });
    expect(
      await new FirestoreAuditInvestigationRepository(store).read(owner, taskId, {
        section: 'contextMessages',
        limit: 10,
      }),
    ).toEqual([]);
  });
  it('blocks reads during privacy erasure', async () => {
    await store.doc('privacyErasureJobs', owner).set({ agentId: owner, status: 'active' });
    await expect(
      new FirestoreAuditInvestigationRepository(store).task(owner, taskId),
    ).rejects.toThrow('Privacy erasure');
  });
});
