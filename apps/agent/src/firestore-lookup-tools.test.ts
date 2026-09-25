import { generateKeyPairSync } from 'node:crypto';
import type { Db } from '@assistant/db';
import { FirestoreCostRepository, FirestoreOwnerContextRepository } from '@assistant/firestore';
import { taskFixture } from '@assistant/persistence/testing';
import { registerSportsTools, registerWeatherTool } from '@assistant/tools/builtin';
import { registerMapsTools } from '@assistant/tools/maps';
import { ToolRegistry } from '@assistant/tools/registry';
import { registerSearchTools } from '@assistant/tools/search';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import {
  disposeStore,
  emulatorStore,
  seedBudget,
} from '../../../packages/firestore/src/test-store.js';

const AGENT = 'owner-agent';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore keyless lookup tools without PostgreSQL',
  () => {
    let store: InstallationStore;
    let sqlAccesses: string[];
    let registry: ToolRegistry;
    let urls: string[];

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      urls.push(url);
      if (url.includes('api.search.brave.com'))
        return Response.json({
          web: { results: [{ url: 'https://example.test', title: 'Example', description: 'x' }] },
        });
      if (url.includes('api.open-meteo.com'))
        return Response.json({
          current: { temperature_2m: 17, weather_code: 3, wind_speed_10m: 10 },
          daily: {
            time: ['2026-09-25'],
            weather_code: [0],
            temperature_2m_max: [20],
            temperature_2m_min: [12],
            precipitation_probability_max: [0],
          },
        });
      if (url.endsWith('/token'))
        return Response.json({ accessToken: 'access', expiresInSeconds: 1800 });
      if (url.includes('maps-api.apple.com'))
        return Response.json({ routes: [], origin: {}, destination: {} });
      if (url.includes('espn')) return Response.json({ events: [], sports: [] });
      void init;
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    function context(taskId?: string) {
      return {
        taskId: taskId ?? 'task',
        agentId: AGENT,
        trust: 'owner',
        tainted: false,
        db: new Proxy(
          {},
          {
            get: (_target, property) => {
              sqlAccesses.push(String(property));
              throw new Error(`Unexpected SQL access: ${String(property)}`);
            },
          },
        ) as Db,
        now: () => new Date(),
        signal: new AbortController().signal,
        log: async () => {},
      } as never;
    }

    function tool(name: string) {
      const found = registry.get(name)?.tool;
      if (!found) throw new Error(`${name} was not registered`);
      return found;
    }

    beforeEach(async () => {
      store = emulatorStore();
      sqlAccesses = [];
      urls = [];
      await seedBudget(store);
      const ownerContext = new FirestoreOwnerContextRepository(store);
      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      registry = new ToolRegistry();
      registerWeatherTool(registry, { ownerContext, fetchImpl });
      registerSportsTools(registry, {
        fetchImpl,
        timezone: async (agentId) => {
          if (agentId !== AGENT) throw new Error('wrong owner');
          return 'America/Los_Angeles';
        },
      });
      registerSearchTools(registry, {
        provider: 'brave',
        apiKey: 'test-key',
        fetchImpl,
        costs: new FirestoreCostRepository(store),
      });
      registerMapsTools(registry, {
        credentials: {
          teamId: 'TEAM123456',
          keyId: 'KEY1234567',
          privateKeyBase64: Buffer.from(
            privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
          ).toString('base64'),
        },
        fetchImpl: fetchImpl as never,
        ownerContext,
      });
      await store.doc('locationPings', 'ping').set({
        id: 'ping',
        agentId: AGENT,
        lat: '37.785700',
        lng: '-122.401100',
        label: 'Union Square',
        accuracyM: 10,
        source: 'ios-app',
        timeZone: 'America/Los_Angeles',
        capturedAt: new Date(Date.now() - 60_000),
        createdAt: new Date(),
      });
    });

    afterEach(async () => {
      await disposeStore(store);
    });

    it('answers current-location weather from the Firestore location ping', async () => {
      const result = (await tool('weather.lookup').execute({ place: '', days: 1 }, context())) as {
        place?: string;
      };
      expect(result.place).toBe('Union Square');
      expect(urls.some((url) => url.includes('latitude=37.7857'))).toBe(true);
      expect(sqlAccesses).toEqual([]);
    });

    it('starts current-location directions from the Firestore location ping', async () => {
      await tool('maps.directions')
        .execute({ destination: 'Oracle Park', mode: 'walking' }, context())
        .catch(() => undefined);
      const directions = urls.find((url) => url.includes('/v1/directions'));
      expect(directions).toContain('origin=37.7857%2C-122.4011');
      expect(sqlAccesses).toEqual([]);
    });

    it('reads the owner timezone for sports without the SQL agent row', async () => {
      const result = (await tool('sports.scores').execute({ league: 'mlb' }, context())) as {
        timeZone?: string;
      };
      expect(result.timeZone).toBe('America/Los_Angeles');
      expect(sqlAccesses).toEqual([]);
    });

    it('records web.search spend in the Firestore cost ledger', async () => {
      const task = taskFixture({
        id: 'search-task',
        agentId: AGENT,
        conversationId: '',
        reminderId: '',
      });
      await store.doc('tasks', task.id).set({ ...task, conversationId: null });
      const result = (await tool('web.search').execute(
        { query: 'firestore cost ledger', count: 1 },
        context(task.id),
      )) as { results: unknown[] };
      expect(result.results).toHaveLength(1);
      const events = await store.collection('costEvents').get();
      expect(events.size).toBe(1);
      expect(events.docs[0]?.get('source')).toBe('external_api');
      expect(events.docs[0]?.get('taskId')).toBe(task.id);
      expect(sqlAccesses).toEqual([]);
    });
  },
);
