import { type AmbientSnapshotRow, ambientSnapshots, type Db } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { withSpan } from '../otel.js';
import { formatLocationLine, latestLocation } from './location.js';

/**
 * Ambient "right now" context (Phase 25). A cheap refresh job fuses the transient
 * sources — the owner's current location (Phase 15) and the local weather — into
 * ONE compiled block plus derived flags, cached in `ambient_snapshots` so every
 * planning step reads it once (the same computed-once pattern as the owner card)
 * instead of calling a weather/location tool mid-task. The block is ephemeral
 * operational state, never memory: it is superseded by the next refresh and never
 * enters extraction. Calendar-pressure and health (Phase 16) are future sources;
 * missing sources degrade gracefully rather than serving stale data.
 */

/** Minutes a compiled snapshot stays authoritative before we fall back to location-only. */
const AMBIENT_TTL_MINUTES = 90;
const WEATHER_TIMEOUT_MS = 10_000;
const RAIN_SOON_PROBABILITY = 60;

/** Subset of WMO weather codes → short description; rainy/snowy codes drive flags. */
const WMO: Record<number, string> = {
  0: 'clear',
  1: 'mostly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'freezing fog',
  51: 'light drizzle',
  53: 'drizzle',
  55: 'heavy drizzle',
  61: 'light rain',
  63: 'rain',
  65: 'heavy rain',
  66: 'freezing rain',
  67: 'freezing rain',
  71: 'light snow',
  73: 'snow',
  75: 'heavy snow',
  77: 'snow grains',
  80: 'rain showers',
  81: 'rain showers',
  82: 'violent rain showers',
  85: 'snow showers',
  86: 'snow showers',
  95: 'thunderstorm',
  96: 'thunderstorm with hail',
  99: 'thunderstorm with hail',
};

function describeWeather(code: number): string {
  return WMO[code] ?? 'unsettled';
}
function isWet(code: number): boolean {
  return (code >= 51 && code <= 86) || code >= 95;
}

export interface WeatherDay {
  /** YYYY-MM-DD in the location's own timezone (Open-Meteo `daily.time`). */
  date: string;
  code: number;
  description: string;
  lowC: number;
  highC: number;
  precipProbabilityMax: number;
}

export interface WeatherNow {
  tempC: number;
  code: number;
  description: string;
  windKmh: number;
  humidity?: number;
  highC: number;
  lowC: number;
  precipProbabilityMax: number;
  /** Tomorrow onward — a "this weekend" question needs more than today. */
  forecast: WeatherDay[];
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** Short weekday for a local-date string, pinned to UTC so the server's zone never shifts it. */
function weekdayName(date: string): string {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!parsed) return date;
  return new Date(
    Date.UTC(Number(parsed[1]), Number(parsed[2]) - 1, Number(parsed[3])),
  ).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}

/** Current conditions + the week's forecast from the free Open-Meteo API (no key). */
export async function fetchWeather(
  lat: number,
  lng: number,
  fetchImpl: FetchLike = fetch,
): Promise<WeatherNow | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    '&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m' +
    '&daily=time,weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    '&forecast_days=7&timezone=auto';
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`weather fetch failed: ${res.status}`);
  const data = (await res.json()) as {
    current?: {
      temperature_2m?: number;
      weather_code?: number;
      wind_speed_10m?: number;
      relative_humidity_2m?: number;
    };
    daily?: {
      time?: string[];
      weather_code?: number[];
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
      precipitation_probability_max?: number[];
    };
  };
  const cur = data.current;
  const day = data.daily;
  if (!cur || typeof cur.temperature_2m !== 'number') return null;
  const forecast = (day?.time ?? [])
    .slice(1)
    .map((date, offset): WeatherDay | null => {
      const index = offset + 1;
      const low = day?.temperature_2m_min?.[index];
      const high = day?.temperature_2m_max?.[index];
      if (typeof low !== 'number' || typeof high !== 'number') return null;
      const code = day?.weather_code?.[index] ?? 0;
      return {
        date,
        code,
        description: describeWeather(code),
        lowC: Math.round(low),
        highC: Math.round(high),
        precipProbabilityMax: day?.precipitation_probability_max?.[index] ?? 0,
      };
    })
    .filter((entry): entry is WeatherDay => entry !== null);
  return {
    tempC: Math.round(cur.temperature_2m),
    code: cur.weather_code ?? day?.weather_code?.[0] ?? 0,
    description: describeWeather(cur.weather_code ?? day?.weather_code?.[0] ?? 0),
    windKmh: Math.round(cur.wind_speed_10m ?? 0),
    humidity:
      typeof cur.relative_humidity_2m === 'number'
        ? Math.round(cur.relative_humidity_2m)
        : undefined,
    highC: Math.round(day?.temperature_2m_max?.[0] ?? cur.temperature_2m),
    lowC: Math.round(day?.temperature_2m_min?.[0] ?? cur.temperature_2m),
    precipProbabilityMax: day?.precipitation_probability_max?.[0] ?? 0,
    forecast,
  };
}

export interface AmbientSnapshotResult {
  computed: boolean;
  hasLocation: boolean;
  hasWeather: boolean;
  flags: Record<string, boolean>;
}

/**
 * Code job `ambient.refresh`: compile the current ambient block and cache it.
 * No location → the snapshot is cleared (nothing to serve) rather than kept
 * stale. Weather failures degrade to a location-only block (never old weather).
 */
export async function refreshAmbientSnapshot(
  deps: { db: Db; fetchImpl?: FetchLike; heartbeat?: () => Promise<void> },
  opts: { agentId: string; now?: Date } = { agentId: '' },
): Promise<AmbientSnapshotResult> {
  const { db } = deps;
  const now = opts.now ?? new Date();

  return withSpan('ambient.refresh', {}, async () => {
    await deps.heartbeat?.();
    const retentionDays = loadConfig().LOCATION_RETENTION_DAYS;
    const ping = await latestLocation(db, opts.agentId, retentionDays);
    if (!ping) {
      // No fresh location — clear any stale snapshot so nothing outdated is served.
      await db.delete(ambientSnapshots).where(eq(ambientSnapshots.agentId, opts.agentId));
      return { computed: false, hasLocation: false, hasWeather: false, flags: {} };
    }

    let weather: WeatherNow | null = null;
    try {
      weather = await fetchWeather(Number(ping.lat), Number(ping.lng), deps.fetchImpl);
    } catch (err) {
      console.error('ambient: weather fetch failed — location-only block', err);
    }
    await deps.heartbeat?.();

    const flags: Record<string, boolean> = {
      has_location: true,
      has_weather: weather !== null,
      raining_now: weather ? isWet(weather.code) : false,
      raining_soon: weather ? weather.precipProbabilityMax >= RAIN_SOON_PROBABILITY : false,
    };

    const locationLine = formatLocationLine(ping, now) ?? '';
    const lines = ['Right now (ambient context — transient, not a stored fact):', locationLine];
    if (weather) {
      lines.push(
        `Weather there: ${weather.description}, ${weather.tempC}°C (today ${weather.lowC}–${weather.highC}°C, ` +
          `${weather.precipProbabilityMax}% chance of rain, wind ${weather.windKmh} km/h` +
          (weather.humidity === undefined ? '' : `, humidity ${weather.humidity}%`) +
          ').' +
          (flags.raining_soon ? ' Rain is likely today — factor it into anything outdoors.' : ''),
      );
      if (weather.forecast.length > 0) {
        lines.push(
          'Coming days: ' +
            weather.forecast
              .map(
                (day) =>
                  `${weekdayName(day.date)} ${day.lowC}–${day.highC}°C, ${day.description}` +
                  (day.precipProbabilityMax >= 30
                    ? `, ${day.precipProbabilityMax}% chance of rain`
                    : ''),
              )
              .join('; ') +
            '.',
        );
      }
    } else {
      lines.push('Weather is unavailable right now.');
    }
    const block = lines.filter(Boolean).join('\n');

    await db
      .insert(ambientSnapshots)
      .values({
        agentId: opts.agentId,
        block,
        flags,
        sources: {
          location: { capturedAt: ping.capturedAt.toISOString(), label: ping.label },
          weather: weather ? { ...weather, fetchedAt: now.toISOString() } : null,
        },
        computedAt: now,
      })
      .onConflictDoUpdate({
        target: ambientSnapshots.agentId,
        set: {
          block,
          flags,
          sources: {
            location: { capturedAt: ping.capturedAt.toISOString(), label: ping.label },
            weather: weather ? { ...weather, fetchedAt: now.toISOString() } : null,
          },
          computedAt: now,
        },
      });

    return { computed: true, hasLocation: true, hasWeather: weather !== null, flags };
  });
}

/**
 * The ambient block for the owner's prompt. Returns the cached snapshot when it
 * is fresh; when it is stale or missing, degrades to the raw current-location
 * line (Phase 15) rather than serving old weather — never blocks on the network.
 */
export async function getAmbientBlock(
  db: Db,
  agentId: string,
  opts: { now?: Date; ttlMinutes?: number } = {},
): Promise<string | undefined> {
  const now = opts.now ?? new Date();
  const ttl = (opts.ttlMinutes ?? AMBIENT_TTL_MINUTES) * 60_000;
  const [snap] = await db
    .select()
    .from(ambientSnapshots)
    .where(eq(ambientSnapshots.agentId, agentId))
    .limit(1);
  if (snap?.block && now.getTime() - snap.computedAt.getTime() <= ttl) {
    return snap.block;
  }
  // Stale/absent snapshot: fall back to the freshest location on its own.
  const ping = await latestLocation(db, agentId, loadConfig().LOCATION_RETENTION_DAYS);
  return formatLocationLine(ping, now);
}

/** The derived flags from the current snapshot (empty when none/stale). */
export function ambientFlags(snap: AmbientSnapshotRow | null | undefined): Record<string, boolean> {
  return (snap?.flags as Record<string, boolean>) ?? {};
}
