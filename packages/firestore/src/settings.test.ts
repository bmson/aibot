import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { FirestoreScheduleRepository } from './schedules.js';
import { FirestoreSettingsRepository } from './settings.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe('Firestore settings repositories', () => {
  const stores: ReturnType<typeof emulatorStore>[] = [];
  afterEach(async () => Promise.all(stores.splice(0).map(disposeStore)));

  it('reads and updates only the deterministic owner settings and preferences', async () => {
    const now = new Date('2026-09-19T20:00:00.000Z');
    const store = emulatorStore(() => now);
    stores.push(store);
    const ownerId = randomUUID();
    const foreignId = randomUUID();
    const owner = {
      id: ownerId,
      name: 'Owner',
      email: 'owner@example.test',
      calendarId: null,
      phoneE164: null,
      avatarUrl: null,
      signature: 'old',
      timezone: 'UTC',
      locale: 'en-US',
      workspacePrefix: 'owner',
      browserProfilePath: null,
      credentialRefs: { encrypted: 'excluded from mutations' },
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    await Promise.all([
      store.doc('agents', ownerId).set(owner),
      store.doc('agents', foreignId).set({
        ...owner,
        id: foreignId,
        name: 'Foreign',
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
      }),
      store.doc('notificationPrefs', ownerId).set({
        agentId: ownerId,
        quietStartMin: 120,
        quietEndMin: 360,
        ambientDailyCap: 4,
        createdAt: owner.createdAt,
        updatedAt: owner.updatedAt,
      }),
      store.doc('proactivePings', 'quiet').set({
        id: 'quiet',
        agentId: ownerId,
        channel: 'in_app',
        urgency: 'ambient',
        delivered: false,
        reason: 'quiet-hours',
        createdAt: new Date('2026-09-19T19:00:00.000Z'),
      }),
      store.doc('proactivePings', 'cap').set({
        id: 'cap',
        agentId: ownerId,
        channel: 'in_app',
        urgency: 'ambient',
        delivered: false,
        reason: 'daily-cap',
        createdAt: new Date('2026-09-19T18:00:00.000Z'),
      }),
      store.doc('proactivePings', 'old').set({
        id: 'old',
        agentId: ownerId,
        channel: 'in_app',
        urgency: 'ambient',
        delivered: false,
        reason: 'daily-cap',
        createdAt: new Date('2026-09-17T18:00:00.000Z'),
      }),
      store.doc('proactivePings', 'foreign').set({
        id: 'foreign',
        agentId: foreignId,
        channel: 'in_app',
        urgency: 'ambient',
        delivered: false,
        reason: 'quiet-hours',
        createdAt: new Date('2026-09-19T19:00:00.000Z'),
      }),
    ]);
    const repository = new FirestoreSettingsRepository(store);

    await expect(repository.getOwner()).resolves.toMatchObject({ id: ownerId, name: 'Owner' });
    await expect(repository.getNotificationPrefs(ownerId)).resolves.toEqual({
      quietStartMin: 120,
      quietEndMin: 360,
      ambientDailyCap: 4,
    });
    await expect(
      repository.countHeldPings(ownerId, new Date('2026-09-18T20:00:00.000Z')),
    ).resolves.toEqual({ quietHours: 1, dailyCap: 1 });
    await expect(
      repository.updateOwner(ownerId, {
        timezone: 'America/Los_Angeles',
        locale: 'en',
        signature: 'new',
      }),
    ).resolves.toBe(true);
    await expect(
      repository.updateNotificationPrefs(ownerId, {
        quietStartMin: null,
        quietEndMin: null,
        ambientDailyCap: 9,
      }),
    ).resolves.toBe(true);
    expect((await store.doc('agents', ownerId).get()).data()).toMatchObject({
      timezone: 'America/Los_Angeles',
      locale: 'en',
      signature: 'new',
      credentialRefs: { encrypted: 'excluded from mutations' },
    });
    expect((await store.doc('agents', foreignId).get()).get('signature')).toBe('old');
    const updatedPrefs = await store.doc('notificationPrefs', ownerId).get();
    expect(updatedPrefs.data()).toMatchObject({
      quietStartMin: null,
      quietEndMin: null,
      ambientDailyCap: 9,
    });
    expect(updatedPrefs.get('createdAt').toDate()).toEqual(owner.createdAt);
  });

  it('toggles owner schedules while refusing reminders and foreign schedules', async () => {
    const store = emulatorStore(() => new Date('2026-09-19T20:00:00.000Z'));
    stores.push(store);
    const ownerId = randomUUID();
    const repository = new FirestoreScheduleRepository(store);
    const owned = await repository.ensure({
      agentId: ownerId,
      name: 'daily job',
      cron: '0 9 * * *',
      taskTemplate: {},
      nextRunAt: new Date('2026-09-20T09:00:00.000Z'),
    });
    const reminder = await repository.ensure({
      agentId: ownerId,
      name: 'reminder:test',
      cron: '0 9 * * *',
      taskTemplate: {},
      nextRunAt: new Date('2026-09-20T09:00:00.000Z'),
    });
    await expect(repository.setOwnerEnabled(ownerId, owned.id, true)).resolves.toBe(true);
    expect((await store.doc('schedules', owned.id).get()).get('nextRunAt')).toBeNull();
    await expect(repository.setOwnerEnabled(ownerId, reminder.id, false)).resolves.toBe(false);
    await expect(repository.setOwnerEnabled(randomUUID(), owned.id, false)).resolves.toBe(false);
  });
});
