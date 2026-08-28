import {
  fetchWeather,
  geocodePlace,
  latestLocation,
  loadConfig,
  type WeatherNow,
  weekdayName,
} from '@assistant/core';
import type { Db } from '@assistant/db';

/**
 * The `weather.lookup` machinery. The ambient block (Phase 25) already carries
 * conditions where the owner is standing, but it can only ever answer about
 * here-and-now: it needs a fresh location ping to exist at all, and it knows one
 * place. "What's the weather in San Francisco?" from an owner sitting in Oslo —
 * or from any install with no location sharing — had no source behind it, so the
 * model could only apologise for having no data. Triage already routes those
 * questions to the tools path (see looksLikeWeatherLookup); this is the tool
 * that answers them.
 *
 * Open-Meteo needs no API key, so this is a platform builtin rather than a
 * module: every install can answer a weather question, with or without search
 * configured.
 */

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface WeatherForecastRow {
  date: string;
  /** "Sat" — the response contract requires every forecast row to name its day. */
  weekday: string;
  description: string;
  lowC: number;
  highC: number;
  precipProbabilityMax: number;
}

export interface WeatherLookupResult {
  /** Where this answer is actually about, as resolved — never the raw query. */
  place: string;
  /** True when the place came from the owner's current location, not the query. */
  usedCurrentLocation: boolean;
  current: {
    tempC: number;
    description: string;
    highC: number;
    lowC: number;
    precipProbabilityMax: number;
    windKmh: number;
    humidity?: number;
  };
  forecast: WeatherForecastRow[];
}

/** Shape the raw reading into the day-named rows the response contract expects. */
export function toLookupResult(
  place: string,
  usedCurrentLocation: boolean,
  weather: WeatherNow,
  days: number,
): WeatherLookupResult {
  return {
    place,
    usedCurrentLocation,
    current: {
      tempC: weather.tempC,
      description: weather.description,
      highC: weather.highC,
      lowC: weather.lowC,
      precipProbabilityMax: weather.precipProbabilityMax,
      windKmh: weather.windKmh,
      ...(weather.humidity === undefined ? {} : { humidity: weather.humidity }),
    },
    forecast: weather.forecast.slice(0, days).map((day) => ({
      date: day.date,
      weekday: weekdayName(day.date),
      description: day.description,
      lowC: day.lowC,
      highC: day.highC,
      precipProbabilityMax: day.precipProbabilityMax,
    })),
  };
}

export interface WeatherLookupInput {
  db: Db;
  agentId: string;
  /** A named place; omitted/empty means "where the owner is now". */
  place?: string;
  days: number;
  fetchImpl?: FetchLike;
}

/**
 * Resolve a place (named, or the owner's latest location ping) and read the
 * weather there. Returns a `{ error }` shape rather than throwing for the two
 * ordinary misses — an unknown place name, and no location on file — because
 * both are answers the model should relay, not failures worth a retry.
 */
export async function lookupWeather(
  input: WeatherLookupInput,
): Promise<WeatherLookupResult | { error: string }> {
  const { db, agentId, days, fetchImpl } = input;
  const named = input.place?.trim();

  let place: string;
  let lat: number;
  let lng: number;

  if (named) {
    const found = await geocodePlace(named, fetchImpl);
    if (!found) {
      return {
        error: `no place named "${named.slice(0, 120)}" was found — ask which place is meant`,
      };
    }
    place = found.label;
    lat = found.lat;
    lng = found.lng;
  } else {
    const ping = await latestLocation(db, agentId, loadConfig().LOCATION_RETENTION_DAYS);
    if (!ping) {
      return {
        error:
          'no place was given and no recent location is on file — ask which place the weather is for',
      };
    }
    place = ping.label || 'your current location';
    lat = Number(ping.lat);
    lng = Number(ping.lng);
  }

  const weather = await fetchWeather(lat, lng, fetchImpl);
  if (!weather) return { error: `no weather reading is available for ${place} right now` };
  return toLookupResult(place, !named, weather, days);
}
