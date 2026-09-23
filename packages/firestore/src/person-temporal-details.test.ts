import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getFirestorePersonTemporalDetails } from './person-temporal-details.js';
import { createInstallationStore } from './store.js';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore person temporal details', () => {
  const installationId = `person-temporal-${randomUUID()}`;
  const foreignInstallationId = `person-temporal-foreign-${randomUUID()}`;
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const contactId = randomUUID();
  const ownerId = randomUUID();
  const foreignContactId = randomUUID();
  const now = new Date('2026-09-22T12:00:00Z');
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  const foreignStore = createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId: foreignInstallationId,
  });

  const experience = (id: string, patch: Record<string, unknown> = {}) => ({
    id,
    agentId,
    subjectContactId: contactId,
    category: 'experience',
    content: id,
    kind: 'episode',
    originTrust: 'owner',
    createdAt: new Date('2026-09-18T12:00:00Z'),
    validFrom: null,
    expiresAt: null,
    quarantined: false,
    ...patch,
  });
  const occasion = (id: string, patch: Record<string, unknown> = {}) => ({
    id,
    agentId,
    contactId,
    kind: 'birthday',
    label: '',
    month: 11,
    day: 12,
    year: 1990,
    recurrence: 'annual',
    leadDays: 14,
    quarantined: false,
    ...patch,
  });

  beforeAll(async () => {
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('contacts', contactId).set({ id: contactId, name: 'Anna', trust: 'confirmed' }),
      store.doc('contacts', ownerId).set({ id: ownerId, name: 'Owner', trust: 'owner' }),
      foreignStore.doc('agents', foreignAgentId).set({ id: foreignAgentId }),
      foreignStore.doc('contacts', foreignContactId).set({
        id: foreignContactId,
        name: 'Foreign',
        trust: 'confirmed',
      }),
      store.doc('memories', 'a-event').set(experience('a-event')),
      store
        .doc('memories', 'b-event')
        .set(experience('b-event', { validFrom: new Date('2026-09-20T12:00:00Z') })),
      store.doc('memories', 'quarantined').set(experience('quarantined', { quarantined: true })),
      store
        .doc('memories', 'expired')
        .set(experience('expired', { expiresAt: new Date('2026-09-21T12:00:00Z') })),
      store
        .doc('memories', 'wrong-agent')
        .set(experience('wrong-agent', { agentId: foreignAgentId })),
      store
        .doc('memories', 'wrong-contact')
        .set(experience('wrong-contact', { subjectContactId: foreignContactId })),
      store.doc('memories', 'knowledge').set(experience('knowledge', { category: 'knowledge' })),
      store.doc('occasions', 'birthday').set(occasion('birthday')),
      store.doc('occasions', 'hidden').set(occasion('hidden', { quarantined: true })),
      store.doc('occasions', 'foreign').set(occasion('foreign', { agentId: foreignAgentId })),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      store.db.recursiveDelete(store.root),
      foreignStore.db.recursiveDelete(foreignStore.root),
    ]);
    await Promise.all([store.db.terminate(), foreignStore.db.terminate()]);
  });

  it('returns actual active experience dates and non-quarantined occasions', async () => {
    const result = await getFirestorePersonTemporalDetails(store, agentId, contactId, now);
    expect(result?.events.map((event) => [event.id, event.dateIsRecordTime])).toEqual([
      ['b-event', false],
      ['a-event', true],
    ]);
    expect(result?.lastContactAt).toEqual(new Date('2026-09-20T12:00:00Z'));
    expect(result?.occasions.map((row) => row.id)).toEqual(['birthday']);
  });

  it('keeps the latest twenty events after sorting by stated or record time', async () => {
    const batch = store.db.batch();
    for (let day = 1; day <= 21; day++) {
      const id = `timeline-${day}`;
      batch.set(
        store.doc('memories', id),
        experience(id, { validFrom: new Date(Date.UTC(2026, 8, day)) }),
      );
    }
    await batch.commit();
    try {
      const result = await getFirestorePersonTemporalDetails(store, agentId, contactId, now);
      expect(result?.events).toHaveLength(20);
      expect(result?.events[0]?.id).toBe('timeline-21');
      expect(result?.events.at(-1)?.id).toBe('timeline-4');
      expect(result?.lastContactAt).toEqual(new Date('2026-09-21T00:00:00Z'));
    } finally {
      const cleanup = store.db.batch();
      for (let day = 1; day <= 21; day++) cleanup.delete(store.doc('memories', `timeline-${day}`));
      await cleanup.commit();
    }
  });

  it('fails closed instead of truncating an oversized occasion scan', async () => {
    for (let offset = 0; offset <= 500; offset += 500) {
      const batch = store.db.batch();
      for (let index = offset; index < Math.min(offset + 500, 501); index++) {
        const id = `large-occasion-${index}`;
        batch.set(store.doc('occasions', id), occasion(id));
      }
      await batch.commit();
    }
    try {
      await expect(
        getFirestorePersonTemporalDetails(store, agentId, contactId, now),
      ).rejects.toThrow('scan bound reached');
    } finally {
      for (let offset = 0; offset <= 500; offset += 500) {
        const batch = store.db.batch();
        for (let index = offset; index < Math.min(offset + 500, 501); index++)
          batch.delete(store.doc('occasions', `large-occasion-${index}`));
        await batch.commit();
      }
    }
  });

  it('hides absent, owner, and foreign-installation contacts', async () => {
    for (const id of [randomUUID(), ownerId, foreignContactId])
      expect(await getFirestorePersonTemporalDetails(store, agentId, id, now)).toBeNull();
  });

  it('fails closed on a malformed experience quarantine flag', async () => {
    await store.doc('memories', 'malformed').set(experience('malformed', { quarantined: null }));
    try {
      await expect(
        getFirestorePersonTemporalDetails(store, agentId, contactId, now),
      ).rejects.toThrow('malformed experience');
    } finally {
      await store.doc('memories', 'malformed').delete();
    }
  });

  it('requires the one configured agent and respects privacy erasure', async () => {
    await expect(
      getFirestorePersonTemporalDetails(store, foreignAgentId, contactId, now),
    ).rejects.toThrow('exactly one configured agent');
    await store.doc('agents', foreignAgentId).set({ id: foreignAgentId });
    try {
      await expect(
        getFirestorePersonTemporalDetails(store, agentId, contactId, now),
      ).rejects.toThrow('exactly one configured agent');
    } finally {
      await store.doc('agents', foreignAgentId).delete();
    }
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    try {
      await expect(
        getFirestorePersonTemporalDetails(store, agentId, contactId, now),
      ).rejects.toThrow('Privacy erasure is in progress');
    } finally {
      await store.doc('privacyErasureJobs', agentId).delete();
    }
  });
});
