import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreDeviceTokenRepository } from './device-tokens.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const token = 'ab'.repeat(32);

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore device tokens', () => {
  let store: InstallationStore;
  let repository: FirestoreDeviceTokenRepository;
  let clock = new Date('2026-09-24T08:00:00.000Z');
  const agentId = randomUUID();

  beforeEach(async () => {
    clock = new Date('2026-09-24T08:00:00.000Z');
    store = emulatorStore(() => clock);
    repository = new FirestoreDeviceTokenRepository(store);
    await store.doc('agents', agentId).set({ id: agentId });
  });

  afterEach(async () => disposeStore(store));

  async function rows() {
    return (await store.collection('deviceTokens').get()).docs.map((doc) => doc.data());
  }

  it('registers once per token and refreshes on re-registration', async () => {
    await repository.register(agentId, { token, platform: 'ios', environment: 'production' });
    clock = new Date('2026-09-24T09:00:00.000Z');
    await repository.register(agentId, { token, platform: 'ios', environment: 'sandbox' });
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      agentId,
      token,
      platform: 'ios',
      environment: 'sandbox',
      invalidatedAt: null,
    });
    expect(row?.lastSeenAt.toDate()).toEqual(clock);
    expect(row?.createdAt.toDate()).toEqual(new Date('2026-09-24T08:00:00.000Z'));
  });

  it('revives an imported, invalidated row instead of adding a second one', async () => {
    const importedId = randomUUID();
    await store.doc('deviceTokens', importedId).set({
      id: importedId,
      agentId,
      token,
      platform: 'ios',
      environment: 'production',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
      invalidatedAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    await repository.register(agentId, { token, platform: 'ios', environment: 'production' });
    expect(await rows()).toEqual([
      expect.objectContaining({ id: importedId, invalidatedAt: null }),
    ]);
  });

  it('keeps concurrent first registrations to one row', async () => {
    await Promise.all(
      Array.from({ length: 5 }, () =>
        repository.register(agentId, { token, platform: 'ios', environment: 'production' }),
      ),
    );
    expect(await rows()).toHaveLength(1);
  });

  it('refuses unconfigured owners and active privacy erasure', async () => {
    await expect(
      repository.register(randomUUID(), { token, platform: 'ios', environment: 'production' }),
    ).rejects.toThrow('Device registration requires one matching configured agent');
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'running' });
    await expect(
      repository.register(agentId, { token, platform: 'ios', environment: 'production' }),
    ).rejects.toThrow('Privacy erasure is in progress');
    expect(await rows()).toEqual([]);
  });
});
