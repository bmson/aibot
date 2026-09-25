import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreActiveJobLookup } from './active-jobs.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore active job lookup', () => {
  let store: InstallationStore;
  let lookup: FirestoreActiveJobLookup;
  const agentId = randomUUID();

  beforeEach(() => {
    store = emulatorStore();
    lookup = new FirestoreActiveJobLookup(store);
  });

  afterEach(async () => disposeStore(store));

  const task = (id: string, patch: Record<string, unknown>) =>
    store.doc('tasks', id).set({
      id,
      agentId,
      status: 'pending',
      trigger: { payload: { job: 'memory.consolidate' } },
      createdAt: new Date(),
      ...patch,
    });

  it('finds only this agent’s unfinished task for the named job', async () => {
    await task('done', { status: 'done' });
    await task('other-job', { trigger: { payload: { job: 'memory.graph_sync' } } });
    await task('foreign', { agentId: randomUUID() });
    expect(await lookup.findActive(agentId, 'memory.consolidate')).toBeNull();

    await task('running', { status: 'running' });
    expect(await lookup.findActive(agentId, 'memory.consolidate')).toEqual({
      id: 'running',
      status: 'running',
    });
  });
});
