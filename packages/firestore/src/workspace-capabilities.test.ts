import { randomUUID } from 'node:crypto';
import type { AgentReadinessSource } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';
import { FirestoreWorkspaceCapabilityRepository } from './workspace-capabilities.js';

const expectedModules = ['google', 'search'];
const ready = {
  ready: true,
  database: 'firestore',
  modules: [
    { module: 'google', enabled: true, ready: true, detail: 'ready' },
    { module: 'search', enabled: false, ready: false, detail: 'disabled' },
  ],
};

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore mobile workspace capability readiness',
  () => {
    let store: InstallationStore;
    let agentId: string;

    beforeEach(async () => {
      store = emulatorStore();
      agentId = randomUUID();
      await store.doc('agents', agentId).set({ id: agentId, name: 'Owner' });
    });

    afterEach(async () => disposeStore(store));

    function repository(source: AgentReadinessSource) {
      return new FirestoreWorkspaceCapabilityRepository(store, agentId, source);
    }

    it('requires the configured owner and returns only complete live Firestore diagnostics', async () => {
      const read = vi.fn<AgentReadinessSource['read']>().mockResolvedValue(ready);
      const reader = repository({ read });
      expect(await reader.load(agentId, expectedModules)).toEqual({
        statusAvailable: true,
        diagnostics: ready.modules,
      });
      expect(read).toHaveBeenCalledExactlyOnceWith(agentId);

      await store.doc('agents', 'foreign').set({ id: 'foreign', name: 'Foreign' });
      await expect(reader.load('foreign', expectedModules)).rejects.toThrow(
        'outside the configured installation',
      );
      expect(read).toHaveBeenCalledTimes(1);
      await store.doc('agents', agentId).delete();
      await expect(reader.load(agentId, expectedModules)).rejects.toThrow(
        'outside the configured installation',
      );
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('fails closed when the PostgreSQL-offline agent source is missing or malformed', async () => {
      const read = vi.fn<AgentReadinessSource['read']>().mockRejectedValue(new Error('offline'));
      const reader = repository({ read });
      expect(await reader.load(agentId, expectedModules)).toEqual({
        statusAvailable: false,
        diagnostics: [],
      });
      read.mockResolvedValue({ ready: false, database: 'unavailable' });
      expect((await reader.load(agentId, expectedModules)).statusAvailable).toBe(false);
      read.mockResolvedValue({ ...ready, modules: [ready.modules[0], ready.modules[0]] });
      expect((await reader.load(agentId, expectedModules)).statusAvailable).toBe(false);
      read.mockResolvedValue({ ...ready, modules: [ready.modules[0]] });
      expect((await reader.load(agentId, expectedModules)).statusAvailable).toBe(false);
      read.mockResolvedValue({
        ...ready,
        modules: [ready.modules[0], { ...ready.modules[1], ready: true }],
      });
      expect((await reader.load(agentId, expectedModules)).statusAvailable).toBe(false);
    });

    it('rejects an erasure in progress or completed during the live read', async () => {
      const read = vi.fn<AgentReadinessSource['read']>().mockResolvedValue(ready);
      const reader = repository({ read });
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      await expect(reader.load(agentId, expectedModules)).rejects.toThrow(
        'Privacy erasure is in progress',
      );
      expect(read).not.toHaveBeenCalled();
      await store.doc('privacyErasureJobs', agentId).delete();

      read.mockImplementation(async () => {
        await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'complete' });
        return ready;
      });
      await expect(reader.load(agentId, expectedModules)).rejects.toThrow(
        'Privacy erasure changed during read',
      );
    });

    it('rejects an owner removed during the live readiness request', async () => {
      const read = vi.fn<AgentReadinessSource['read']>().mockImplementation(async () => {
        await store.doc('agents', agentId).delete();
        return ready;
      });
      await expect(repository({ read }).load(agentId, expectedModules)).rejects.toThrow(
        'outside the configured installation',
      );
    });
  },
);
