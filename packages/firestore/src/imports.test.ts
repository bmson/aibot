import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreImportCommandRepository, FirestoreImportJobRepository } from './imports.js';
import { encodeRecord, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const space = { provider: 'synthetic', model: 'fixture', dimensions: 1536, revision: '1' };

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore import source identity', () => {
  let store: InstallationStore;
  const agentId = randomUUID();

  beforeEach(async () => {
    store = emulatorStore();
    await store.doc('agents', agentId).set({ id: agentId });
  });

  afterEach(async () => disposeStore(store));

  function legacySource(id: string, source: string) {
    const now = new Date('2026-09-01T00:00:00Z');
    return store.doc('importSources', id).set(
      encodeRecord({
        id,
        agentId,
        source,
        workspacePath: `import/${source}.txt`,
        kind: 'text',
        status: 'done',
        taskId: null,
        itemsTotal: 1,
        itemsProcessed: 1,
        memoriesSaved: 1,
        memoriesQuarantined: 0,
        error: null,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  const start = {
    source: 'mail-2021',
    workspacePath: 'import/mail-2021.mbox',
    kind: 'mbox',
    job: 'import.run' as const,
    payload: {},
    budgetUsdLimit: '0.50',
  };

  it('adopts a source imported from PostgreSQL instead of creating a second one', async () => {
    const legacyId = randomUUID();
    await legacySource(legacyId, 'mail-2021');
    const commands = new FirestoreImportCommandRepository(store, agentId);
    const started = await commands.start(start);
    expect(started.sourceId).toBe(legacyId);
    const rows = await store.collection('importSources').where('source', '==', 'mail-2021').get();
    expect(rows.docs.map((doc) => doc.data())).toEqual([
      expect.objectContaining({
        id: legacyId,
        status: 'pending',
        taskId: started.taskId,
        workspacePath: 'import/mail-2021.mbox',
        kind: 'mbox',
        itemsProcessed: 0,
      }),
    ]);
    await expect(commands.start(start)).rejects.toThrow('import "mail-2021" is already pending');
  });

  it('fails on a duplicated legacy source instead of guessing', async () => {
    await legacySource(randomUUID(), 'mail-2021');
    await legacySource(randomUUID(), 'mail-2021');
    await expect(new FirestoreImportCommandRepository(store, agentId).start(start)).rejects.toThrow(
      'Duplicate import source identity',
    );
  });

  it('refuses job writes outside the configured owner or without the live lease', async () => {
    const commands = new FirestoreImportCommandRepository(store, agentId);
    const started = await commands.start(start);
    const fence = {
      agentId,
      source: 'mail-2021',
      taskId: started.taskId,
      queueGeneration: 0,
      leaseToken: randomUUID(),
    };
    // The task is pending, not running under this lease.
    expect(await new FirestoreImportJobRepository(store, agentId, space).load(fence)).toBeNull();
    expect(
      await new FirestoreImportJobRepository(store, randomUUID(), space).load(fence),
    ).toBeNull();
    await expect(
      new FirestoreImportCommandRepository(store, randomUUID()).start(start),
    ).rejects.toThrow('Imports require exactly one matching configured owner');
  });
});
