import { ambientSnapshots, createDb, type Db, locationPings } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import { fetchWeather, geocodePlace, getAmbientBlock, refreshAmbientSnapshot } from './ambient.js';
import { recordLocationPing } from './location.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

/** A fake Open-Meteo response (overcast, high rain chance today). */
function fakeWeatherFetch(code = 3, precip = 90) {
  return (async () =>
    ({
      ok: true,
      json: async () => ({
        current: {
          temperature_2m: 10.8,
          weather_code: code,
          wind_speed_10m: 9,
          relative_humidity_2m: 72,
        },
        daily: {
          weather_code: [63],
          temperature_2m_max: [12.2],
          temperature_2m_min: [10.4],
          precipitation_probability_max: [precip],
        },
      }),
    }) as unknown as Response) as unknown as typeof fetch;
}

/** Today plus two coming days, so the forecast line has real content. */
function fakeForecastFetch() {
  return (async () =>
    ({
      ok: true,
      json: async () => ({
        current: { temperature_2m: 10.8, weather_code: 3, wind_speed_10m: 9 },
        daily: {
          time: ['2026-08-24', '2026-08-25', '2026-08-26'],
          weather_code: [3, 0, 61],
          temperature_2m_max: [12.2, 15.6, 13.1],
          temperature_2m_min: [10.4, 9.2, 8.8],
          precipitation_probability_max: [10, 0, 80],
        },
      }),
    }) as unknown as Response) as unknown as typeof fetch;
}

describe('ambient — weather fetch (pure)', () => {
  it('parses current + daily and rounds', async () => {
    const w = await fetchWeather(64, -22, fakeWeatherFetch(3, 40));
    expect(w).toMatchObject({
      tempC: 11,
      code: 3,
      description: 'overcast',
      highC: 12,
      lowC: 10,
      humidity: 72,
    });
    expect(w?.precipProbabilityMax).toBe(40);
  });

  it('throws on a non-ok response', async () => {
    const bad = (async () => ({ ok: false, status: 503 }) as Response) as unknown as typeof fetch;
    await expect(fetchWeather(64, -22, bad)).rejects.toThrow('weather fetch failed');
  });

  describe('geocodePlace', () => {
    /** One gazetteer hit, in Open-Meteo's shape. */
    function fakeGeocodeFetch(results: unknown[]) {
      return (async () =>
        ({
          ok: true,
          json: async () => ({ results }),
        }) as unknown as Response) as unknown as typeof fetch;
    }

    it('resolves a named place to coordinates and a full label', async () => {
      const hit = await geocodePlace(
        'San Francisco',
        fakeGeocodeFetch([
          {
            name: 'San Francisco',
            latitude: 37.77493,
            longitude: -122.41942,
            admin1: 'California',
            country: 'United States',
            timezone: 'America/Los_Angeles',
          },
        ]),
      );
      expect(hit).toEqual({
        label: 'San Francisco, California, United States',
        lat: 37.77493,
        lng: -122.41942,
        timezone: 'America/Los_Angeles',
      });
    });

    it('returns null when the gazetteer has no match', async () => {
      // The caller must be able to say "I could not find that place" rather
      // than silently answering about somewhere else.
      expect(await geocodePlace('Nowherecity', fakeGeocodeFetch([]))).toBeNull();
      const empty = (async () =>
        ({ ok: true, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
      expect(await geocodePlace('Nowherecity', empty)).toBeNull();
    });

    it('never calls out for a blank query', async () => {
      let called = false;
      const spy = (async () => {
        called = true;
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }) as unknown as typeof fetch;
      expect(await geocodePlace('   ', spy)).toBeNull();
      expect(called).toBe(false);
    });

    it('falls back to the query when the hit carries no usable name parts', async () => {
      const hit = await geocodePlace(
        'Somewhere',
        fakeGeocodeFetch([{ latitude: 1.5, longitude: 2.5 }]),
      );
      expect(hit).toMatchObject({ label: 'Somewhere', lat: 1.5, lng: 2.5 });
    });

    it('throws on a non-ok response', async () => {
      const bad = (async () => ({ ok: false, status: 429 }) as Response) as unknown as typeof fetch;
      await expect(geocodePlace('Tokyo', bad)).rejects.toThrow('geocode failed');
    });
  });

  it('parses the coming days, skipping today and dropping malformed entries', async () => {
    const w = await fetchWeather(64, -22, fakeForecastFetch());
    expect(w?.forecast).toEqual([
      {
        date: '2026-08-25',
        code: 0,
        description: 'clear',
        lowC: 9,
        highC: 16,
        precipProbabilityMax: 0,
      },
      {
        date: '2026-08-26',
        code: 61,
        description: 'light rain',
        lowC: 9,
        highC: 13,
        precipProbabilityMax: 80,
      },
    ]);
  });
});

describe('ambient — snapshot refresh + block', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;

  async function cleanup() {
    await db.delete(ambientSnapshots).where(eq(ambientSnapshots.agentId, agentId));
    await db.delete(locationPings).where(eq(locationPings.source, 'xtest-amb'));
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
      await cleanup();
    } catch {
      console.warn('ambient.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp) await cleanup();
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  it('fuses location + weather into a cached block with derived flags', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await recordLocationPing(db, agentId, {
      lat: 64.1466,
      lng: -21.9426,
      label: 'Reykjavík',
      source: 'xtest-amb',
    });

    const r = await refreshAmbientSnapshot(
      { db, fetchImpl: fakeWeatherFetch(63, 100) },
      { agentId },
    );
    expect(r).toMatchObject({ computed: true, hasLocation: true, hasWeather: true });
    expect(r.flags.raining_soon).toBe(true);

    const block = await getAmbientBlock(db, agentId);
    expect(block).toContain('Right now');
    expect(block).toContain('Reykjavík');
    expect(block).toContain('chance of rain');
    expect(block).toContain('factor it into anything outdoors');
  });

  it('adds a coming-days line when the forecast reaches beyond today', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await refreshAmbientSnapshot({ db, fetchImpl: fakeForecastFetch() }, { agentId });

    const block = await getAmbientBlock(db, agentId);
    expect(block).toContain(
      'Coming days: Tue 9–16°C, clear; Wed 9–13°C, light rain, 80% chance of rain.',
    );
  });

  it('falls back to the location line when the snapshot is stale', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // Force a stale snapshot (computed 3h ago); getAmbientBlock's TTL is 90 min.
    await refreshAmbientSnapshot({ db, fetchImpl: fakeWeatherFetch() }, { agentId });
    await db
      .update(ambientSnapshots)
      .set({ computedAt: new Date(Date.now() - 3 * 3600 * 1000) })
      .where(eq(ambientSnapshots.agentId, agentId));

    const block = await getAmbientBlock(db, agentId);
    // Degrades to the fresh location line (no stale weather), never null here.
    expect(block).toContain('Reykjavík');
    expect(block).not.toContain('chance of rain');
  });
});
