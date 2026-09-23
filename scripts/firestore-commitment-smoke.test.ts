import { randomUUID } from 'node:crypto';
import { createInstallationStore } from '@assistant/firestore';
import { expect, it } from 'vitest';
import { firestoreCommitmentSmoke } from './firestore-commitment-smoke.js';

it.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'exercises the mobile commitment query shape in the validation smoke',
  async () => {
    const store = createInstallationStore({
      projectId: 'demo-assistant-test',
      installationId: `commitment-smoke-${randomUUID()}`,
    });
    try {
      await expect(firestoreCommitmentSmoke(store)).resolves.toEqual({ open: 1, snoozed: 1 });
    } finally {
      await store.db.recursiveDelete(store.root);
      await store.db.terminate();
    }
  },
);
