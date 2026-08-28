import type { Db } from '@assistant/db';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../registry.js';
import { registerBuiltinTools } from './index.js';
import { lookupWeather } from './weather.js';

/**
 * The bug these cover: an owner asking "what's the weather in San Francisco?"
 * got an apology. The ambient block only knows where the owner is standing and
 * only when a location ping exists, so any other place had no source behind it.
 */

const GEOCODE_HIT = {
  name: 'San Francisco',
  latitude: 37.77493,
  longitude: -122.41942,
  admin1: 'California',
  country: 'United States',
  timezone: 'America/Los_Angeles',
};

const WEATHER_BODY = {
  current: {
    temperature_2m: 17.4,
    weather_code: 3,
    wind_speed_10m: 14,
    relative_humidity_2m: 68,
  },
  daily: {
    time: ['2026-08-28', '2026-08-29', '2026-08-30'],
    weather_code: [3, 0, 61],
    temperature_2m_max: [19.2, 22.6, 18.1],
    temperature_2m_min: [13.4, 14.2, 12.8],
    precipitation_probability_max: [10, 0, 80],
  },
};

/** Routes the geocoding host and the forecast host to their own fake bodies. */
function fakeFetch(opts: { geocode?: unknown[]; weather?: unknown } = {}) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    const body = url.includes('geocoding-api')
      ? { results: opts.geocode ?? [GEOCODE_HIT] }
      : (opts.weather ?? WEATHER_BODY);
    return { ok: true, json: async () => body } as unknown as Response;
  }) as unknown as (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  return { impl, calls };
}

/** lookupWeather only touches the db on the no-place branch. */
const UNUSED_DB = {} as Db;

describe('lookupWeather', () => {
  it('answers for a named place the owner is nowhere near', async () => {
    const { impl, calls } = fakeFetch();
    const result = await lookupWeather({
      db: UNUSED_DB,
      agentId: 'agent-1',
      place: 'San Francisco',
      days: 7,
      fetchImpl: impl,
    });

    expect(result).toMatchObject({
      place: 'San Francisco, California, United States',
      usedCurrentLocation: false,
      current: {
        tempC: 17,
        description: 'overcast',
        highC: 19,
        lowC: 13,
        precipProbabilityMax: 10,
        windKmh: 14,
        humidity: 68,
      },
    });
    // The forecast is read at the resolved coordinates, not the raw query.
    expect(calls[1]).toContain('latitude=37.77493');
    expect(calls[1]).toContain('longitude=-122.41942');
  });

  it('names the day on every forecast row', async () => {
    // The response contract forbids bare "morning"/"afternoon" rows, so the
    // weekday has to reach the model as data rather than be derived by it.
    const { impl } = fakeFetch();
    const result = await lookupWeather({
      db: UNUSED_DB,
      agentId: 'agent-1',
      place: 'San Francisco',
      days: 7,
      fetchImpl: impl,
    });
    expect('forecast' in result && result.forecast).toEqual([
      {
        date: '2026-08-29',
        weekday: 'Sat',
        description: 'clear',
        lowC: 14,
        highC: 23,
        precipProbabilityMax: 0,
      },
      {
        date: '2026-08-30',
        weekday: 'Sun',
        description: 'light rain',
        lowC: 13,
        highC: 18,
        precipProbabilityMax: 80,
      },
    ]);
  });

  it('honours the requested number of days', async () => {
    const { impl } = fakeFetch();
    const result = await lookupWeather({
      db: UNUSED_DB,
      agentId: 'agent-1',
      place: 'San Francisco',
      days: 1,
      fetchImpl: impl,
    });
    expect('forecast' in result && result.forecast).toHaveLength(1);
  });

  it('reports an unfindable place instead of answering about the wrong one', async () => {
    const { impl, calls } = fakeFetch({ geocode: [] });
    const result = await lookupWeather({
      db: UNUSED_DB,
      agentId: 'agent-1',
      place: 'Atlantis',
      days: 7,
      fetchImpl: impl,
    });
    expect(result).toEqual({
      error: 'no place named "Atlantis" was found — ask which place is meant',
    });
    // No forecast call once the place could not be resolved.
    expect(calls).toHaveLength(1);
  });

  it('asks for a place when none was given and no location is on file', async () => {
    const { impl, calls } = fakeFetch();
    const emptyDb = {
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: async () => [] }) }),
        }),
      }),
    } as unknown as Db;

    const result = await lookupWeather({
      db: emptyDb,
      agentId: 'agent-1',
      days: 7,
      fetchImpl: impl,
    });
    expect(result).toMatchObject({ error: expect.stringContaining('no recent location') });
    expect(calls).toHaveLength(0);
  });

  it('surfaces a reading the provider could not supply', async () => {
    // A body with no `current` block parses to null rather than throwing.
    const { impl } = fakeFetch({ weather: { daily: WEATHER_BODY.daily } });
    const result = await lookupWeather({
      db: UNUSED_DB,
      agentId: 'agent-1',
      place: 'San Francisco',
      days: 7,
      fetchImpl: impl,
    });
    expect(result).toMatchObject({ error: expect.stringContaining('no weather reading') });
  });
});

describe('weather.lookup registration', () => {
  const registry = registerBuiltinTools(new ToolRegistry(), {
    embed: async () => [],
    workspace: {} as Parameters<typeof registerBuiltinTools>[1]['workspace'],
  });

  it('is registered and autonomous', () => {
    const registered = registry.get('weather.lookup');
    expect(registered?.tool.risk).toBe('autonomous');
    expect(registered?.tool.acceptsUntrustedInput).toBe(true);
  });

  it('stays available to every trust tier', () => {
    // Unlike web.fetch/web.search, the destination is hardwired to Open-Meteo,
    // so there is no egress to strip: a weather question asked over email or
    // SMS by a stranger is answerable, and a tainted owner turn does not have
    // to raise an approval card to say whether it will rain.
    for (const tier of ['owner', 'known', 'unknown'] as const) {
      expect(registry.toolsForTask(tier).map((tool) => tool.name)).toContain('weather.lookup');
    }
    const flags = registry.get('weather.lookup')?.flags;
    expect(flags?.networkEgress).toBeUndefined();
    expect(flags?.returnsUntrustedContent).toBeUndefined();
    expect(flags?.outwardFacing).toBeUndefined();
  });

  it('runs end to end through the registered tool, under the task signal', async () => {
    // Covers the wiring itself: deps.fetchImpl reaching the helpers, and the
    // per-call signal merge that lets a cancelled task abort the lookup.
    const { impl, calls } = fakeFetch();
    const seen: (AbortSignal | undefined)[] = [];
    const wired = registerBuiltinTools(new ToolRegistry(), {
      embed: async () => [],
      workspace: {} as Parameters<typeof registerBuiltinTools>[1]['workspace'],
      fetchImpl: (url, init) => {
        seen.push(init?.signal);
        return impl(url, init);
      },
    });

    const controller = new AbortController();
    const result = await wired.get('weather.lookup')?.tool.execute(
      { place: 'San Francisco', days: 6 },
      {
        taskId: 'task-1',
        agentId: 'agent-1',
        trust: 'owner',
        tainted: false,
        db: UNUSED_DB,
        now: () => new Date(),
        signal: controller.signal,
        log: async () => {},
      },
    );

    expect(result).toMatchObject({ place: 'San Francisco, California, United States' });
    expect(calls).toHaveLength(2);
    // Every leg carries a live signal, and aborting the task aborts them.
    expect(seen.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(seen.every((signal) => signal?.aborted)).toBe(false);
    controller.abort();
    expect(seen.every((signal) => signal?.aborted)).toBe(true);
  });

  it('defaults to the current location and every day the provider has', () => {
    // 6, not 7: today is reported as current conditions, so the forecast can
    // only run tomorrow onward. Promising a 7th day would return one row short.
    const schema = registry.get('weather.lookup')?.tool.inputSchema;
    expect(schema?.parse({})).toEqual({ place: '', days: 6 });
  });
});
