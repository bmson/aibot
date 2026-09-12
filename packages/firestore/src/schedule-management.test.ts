import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreScheduleRepository } from './schedules.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore schedule management reads', () => {
  let store: InstallationStore;
  let schedules: FirestoreScheduleRepository;

  beforeEach(() => {
    store = emulatorStore();
    schedules = new FirestoreScheduleRepository(store);
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  async function seed(
    id: string,
    agentId: string,
    options: { enabled?: boolean; name?: string } = {},
  ) {
    await store.doc('schedules', id).set({
      id,
      agentId,
      name: options.name ?? `schedule:${id}`,
      cron: '* * * * *',
      taskTemplate: { reminderKind: 'recurring', reminderText: id },
      enabled: options.enabled ?? true,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: new Date('2026-09-12T12:00:00Z'),
      updatedAt: new Date('2026-09-12T12:00:00Z'),
    });
  }

  it('pages all owner schedules in ID order, including disabled and nonreminder rows', async () => {
    await seed('b', 'owner');
    await seed('d', 'owner', { enabled: false });
    await seed('f', 'owner', { name: 'goal:owner' });
    await seed('a', 'other');

    const first = await schedules.listPage('owner', { limit: 2 });
    expect(first.items.map((row) => row.id)).toEqual(['b', 'd']);
    expect(first.items[1]?.enabled).toBe(false);
    expect(first.nextCursor).toBe('d');

    const second = await schedules.listPage('owner', {
      afterId: first.nextCursor ?? undefined,
      limit: 2,
    });
    expect(second.items.map((row) => row.id)).toEqual(['f']);
    expect(second.nextCursor).toBeNull();
  });

  it('continues after a deleted cursor document', async () => {
    await seed('a', 'owner');
    await seed('b', 'owner');
    await seed('c', 'owner');
    const first = await schedules.listPage('owner', { limit: 1 });
    await store.doc('schedules', first.items[0]?.id ?? '').delete();

    const next = await schedules.listPage('owner', { afterId: first.nextCursor ?? '', limit: 1 });
    expect(next.items.map((row) => row.id)).toEqual(['b']);
  });

  it('validates bounded limits, cursors, empty pages, and row identity', async () => {
    await expect(schedules.listPage('owner', { limit: 0 })).rejects.toThrow('batch');
    await expect(schedules.listPage('owner', { limit: 201 })).rejects.toThrow('batch');
    await expect(schedules.listPage('owner', { afterId: '' })).rejects.toThrow('cursor');
    expect(await schedules.listPage('owner')).toEqual({ items: [], nextCursor: null });

    await store.doc('schedules', 'document').set({
      id: 'different',
      agentId: 'owner',
      name: 'reminder:broken',
      cron: '* * * * *',
      taskTemplate: {},
      enabled: true,
      nextRunAt: null,
    });
    await expect(schedules.listPage('owner')).rejects.toThrow('identity');
  });
});
