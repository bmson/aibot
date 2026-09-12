import { describe, it } from 'vitest';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { firestoreRuntimeSmoke } from '../../../scripts/firestore-runtime-smoke.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore runtime smoke', () => {
  it('exercises synthetic dispatcher and model-routing persistence', async () => {
    const store = emulatorStore();
    try {
      await firestoreRuntimeSmoke(store);
    } finally {
      await disposeStore(store);
    }
  });
});
