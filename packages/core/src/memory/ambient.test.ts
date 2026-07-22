import { ambientSnapshots, createDb, type Db, locationPings } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import { fetchWeather, getAmbientBlock, refreshAmbientSnapshot } from './ambient.js';
import { recordLocationPing } from './location.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

/** A fake Open-Meteo response (overcast, high rain chance today). */
function fakeWeatherFetch(code = 3, precip = 90) {
  return (async () =>
    ({
      ok: true,
      json: async () => ({
        current: { temperature_2m: 10.8, weather_code: code, wind_speed_10m: 9 },
        daily: {
          weather_code: [63],
          temperature_2m_max: [12.2],
          temperature_2m_min: [10.4],
          precipitation_probability_max: [precip],
        },
      }),
    }) as unknown as Response) as unknown as typeof fetch;
}

describe('ambient — weather fetch (pure)', () => {
  it('parses current + daily and rounds', async () => {
    const w = await fetchWeather(64, -22, fakeWeatherFetch(3, 40));
    expect(w).toMatchObject({ tempC: 11, code: 3, description: 'overcast', highC: 12, lowC: 10 });
    expect(w?.precipProbabilityMax).toBe(40);
  });

  it('throws on a non-ok response', async () => {
    const bad = (async () => ({ ok: false, status: 503 }) as Response) as unknown as typeof fetch;
    await expect(fetchWeather(64, -22, bad)).rejects.toThrow('weather fetch failed');
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
