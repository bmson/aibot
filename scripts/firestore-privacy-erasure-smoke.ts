import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FirestorePrivacyErasureRepository, type InstallationStore } from '@assistant/firestore';

/** Synthetic isolated workload that exercises the voice-import index and resumable job. */
export async function firestorePrivacyErasureSmoke(store: InstallationStore) {
  const agentId = randomUUID();
  const sourceId = randomUUID();
  const memoryId = randomUUID();
  const contentHash = `privacy-smoke-${randomUUID()}`;
  await Promise.all([
    store.doc('agents', agentId).set({ id: agentId }),
    store.doc('memories', memoryId).set({ id: memoryId, agentId, contentHash }),
    store.doc('memoryContentHashes', contentHash).set({ memoryId }),
    store.doc('importSources', sourceId).set({
      id: sourceId,
      agentId,
      source: `voice-samples-${sourceId}`,
      workspacePath: 'synthetic/voice-sample.txt',
      taskId: null,
    }),
  ]);
  const repository = new FirestorePrivacyErasureRepository(store);
  assert.deepEqual(await repository.erase(), {
    memories: 1,
    graphRelations: 0,
    writingSamples: 0,
  });
  assert.equal((await store.doc('memoryTombstones', contentHash).get()).exists, true);
  assert.deepEqual(await repository.pendingAssets(), [
    { id: sourceId, workspacePath: 'synthetic/voice-sample.txt' },
  ]);
  // This synthetic path was never written to a workspace.
  await repository.assetDeleted(sourceId);
  await repository.complete();
  return { resumedJobStatus: (await store.doc('privacyErasureJobs', agentId).get()).get('status') };
}
