import { resetConfigForTest } from '@assistant/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { firestoreChatSmoke } from '../../../scripts/firestore-chat-smoke.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore ordinary chat composition', () => {
  beforeEach(() => resetConfigForTest());
  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('runs planning, owner context, learned skills and final delivery without SQL', async () => {
    // Optional historical/graph recall has its own migration gate. This scenario
    // uses the default configuration, with normal owner context and skills active.
    vi.stubEnv('CHAT_RECALL_ENABLED', 'false');
    const store = emulatorStore();
    try {
      expect(await firestoreChatSmoke(store)).toEqual({
        planned: true,
        ownerContext: true,
        skills: true,
        finalized: true,
        sqlAccesses: 0,
      });
    } finally {
      await disposeStore(store);
    }
  });
  it('runs historical and graph recall without SQL', async () => {
    vi.stubEnv('CHAT_RECALL_ENABLED', 'true');
    vi.stubEnv('GRAPH_RAG_ENABLED', 'true');
    const store = emulatorStore();
    try {
      expect(await firestoreChatSmoke(store, { recall: true })).toMatchObject({
        history: true,
        graph: true,
        sqlAccesses: 0,
        finalized: true,
      });
    } finally {
      await disposeStore(store);
    }
  });
});
