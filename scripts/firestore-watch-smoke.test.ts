import { randomUUID } from 'node:crypto';
import { InstallationStore } from '@assistant/firestore';
import { Firestore } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';
import { firestoreWatchSmoke } from './firestore-watch-smoke.js';

function emulatorStore() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
    throw new Error('Firestore tests require a loopback FIRESTORE_EMULATOR_HOST');
  return new InstallationStore(
    new Firestore({ projectId: 'demo-assistant-test', databaseId: '(default)' }),
    `test-${randomUUID()}`,
  );
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore watch smoke', () => {
  it('runs every production watch query shape without PostgreSQL', async () => {
    const store = emulatorStore();
    try {
      await expect(firestoreWatchSmoke(store)).resolves.toEqual({
        listed: 3,
        emailCandidates: 1,
        webClaims: 1,
        fires: 1,
        suggestions: 1,
        expired: 2,
      });
    } finally {
      await store.db.recursiveDelete(store.root);
      await store.db.terminate();
    }
  });
});
