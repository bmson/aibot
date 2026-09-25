import { randomUUID } from 'node:crypto';
import { type ExecutorDeps, executeTask } from '@assistant/core';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const WEATHER = {
  current: { temperature_2m: 17.4, weather_code: 61, wind_speed_10m: 14 },
  daily: {
    time: ['2026-09-24', '2026-09-25'],
    weather_code: [61, 0],
    temperature_2m_max: [19, 22],
    temperature_2m_min: [13, 14],
    precipitation_probability_max: [80, 0],
  },
};

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore ambient refresh job', () => {
  const agentId = randomUUID();
  let store: InstallationStore;
  let deps: ExecutorDeps;
  let sqlAccesses: string[];
  let weatherUrls: string[];

  beforeEach(async () => {
    store = emulatorStore();
    sqlAccesses = [];
    weatherUrls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        weatherUrls.push(url);
        return Response.json(WEATHER);
      }),
    );
    const unavailable = (name: string) =>
      new Proxy(
        {},
        {
          get: (_target, property) => {
            sqlAccesses.push(`${name}.${String(property)}`);
            throw new Error(`Unexpected ${name} access: ${String(property)}`);
          },
        },
      );
    deps = {
      db: unavailable('db') as Db,
      router: unavailable('router') as ExecutorDeps['router'],
      dispatcher: unavailable('dispatcher') as ExecutorDeps['dispatcher'],
      persistence: createFirestoreExecutionPersistence(store, agentId, {
        provider: 'synthetic',
        model: 'ambient-fixture',
        dimensions: 1536,
        revision: '1',
      }),
    };
    await store.doc('agents', agentId).set({ id: agentId, name: 'Owner', timezone: 'UTC' });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await disposeStore(store);
  });

  async function refresh() {
    const tasks = deps.persistence?.tasks;
    if (!tasks) throw new Error('missing tasks');
    const { task } = await tasks.createTask({
      agentId,
      type: 'scheduled',
      trust: 'assistant',
      trigger: { source: 'schedule', payload: { job: 'ambient.refresh' } },
    });
    return executeTask(deps, task.id);
  }

  async function ping(minutesAgo: number) {
    await store.doc('locationPings', 'ping').set({
      id: 'ping',
      agentId,
      lat: '37.785700',
      lng: '-122.401100',
      label: 'Union Square',
      accuracyM: 10,
      source: 'ios-app',
      timeZone: 'America/Los_Angeles',
      capturedAt: new Date(Date.now() - minutesAgo * 60_000),
      createdAt: new Date(),
    });
  }

  it('builds the owner snapshot from a Firestore ping and replaces an imported copy', async () => {
    await ping(5);
    // A PostgreSQL import keys the row by its legacy ID, where nothing reads it.
    await store.doc('ambientSnapshots', 'legacy-row').set({
      id: 'legacy-row',
      agentId,
      block: 'old',
      flags: {},
      sources: {},
      computedAt: new Date(0),
    });

    expect(await refresh()).toEqual({
      outcome: 'done',
      detail: 'ambient: refreshed (location + weather)',
    });
    expect(weatherUrls.some((url) => url.includes('latitude=37.7857'))).toBe(true);
    const snapshot = await deps.persistence?.ownerContext.getAmbientSnapshot(agentId);
    expect(snapshot?.block).toContain('Union Square');
    expect(snapshot?.block).toContain('Weather there');
    expect(snapshot?.flags).toMatchObject({ has_location: true, raining_now: true });
    expect((await store.collection('ambientSnapshots').get()).docs.map((doc) => doc.id)).toEqual([
      (await store.doc('ambientSnapshots', agentId).get()).id,
    ]);

    // A second refresh keeps the same snapshot identity.
    const firstId = snapshot && (await store.doc('ambientSnapshots', agentId).get()).get('id');
    await refresh();
    expect((await store.doc('ambientSnapshots', agentId).get()).get('id')).toBe(firstId);
    expect(sqlAccesses).toEqual([]);
  });

  it('clears the snapshot once no fresh location exists', async () => {
    await ping(5);
    await refresh();
    await store.doc('locationPings', 'ping').delete();

    expect(await refresh()).toEqual({
      outcome: 'done',
      detail: 'ambient: no fresh location — snapshot cleared',
    });
    expect(await deps.persistence?.ownerContext.getAmbientSnapshot(agentId)).toBeNull();
    expect((await store.collection('ambientSnapshots').get()).size).toBe(0);
    expect(sqlAccesses).toEqual([]);
  });

  it('does not write location context while a privacy erasure is running', async () => {
    await ping(5);
    await store
      .doc('privacyErasureJobs', agentId)
      .set({ agentId, status: 'running', updatedAt: new Date() });

    expect((await refresh()).outcome).toBe('failed');
    expect((await store.collection('ambientSnapshots').get()).size).toBe(0);
    expect(sqlAccesses).toEqual([]);
  });
});
