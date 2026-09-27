/**
 * Flight status from FlightAware AeroAPI v4.
 *
 * One host, one path shape: `/flights/{ident}` with the ident either a flight
 * designator the owner named or a FlightAware flight id the runtime already
 * holds. The designator is normalised and checked against a strict pattern
 * before it reaches the URL, so a request cannot name anything else to fetch.
 *
 * Times arrive in UTC. They leave here as ISO 8601 instants carrying the
 * airport's own offset — "2026-10-02T16:40:00+00:00" at Keflavík, "…-04:00" at
 * JFK — because a departure is read on the departure board's clock, and a
 * card's countdown needs an instant it cannot misplace. Everything a card or
 * a Live Activity shows is a field of this result, so the verbatim check has
 * something to check against.
 */

export type FlightsFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

export const AEROAPI_BASE = 'https://aeroapi.flightaware.com/aeroapi';

export type FlightPhase =
  | 'scheduled'
  | 'taxiing'
  | 'en_route'
  | 'landed'
  | 'arrived'
  | 'cancelled'
  | 'diverted';

export interface FlightAirport {
  /** IATA code when the airport has one ("KEF"), else the provider's code. */
  code: string;
  name: string;
  city: string;
  timeZone: string;
  /** "Reykjavik (KEF)": the one string a card shows for the place. */
  label: string;
}

export interface FlightTimes {
  scheduled?: string;
  estimated?: string;
  actual?: string;
  /** The best reading available: actual, else estimated, else scheduled. */
  best?: string;
}

export interface FlightStatus {
  /** FlightAware's id for this one flight; the live refresh reads it back. */
  id: string;
  /** "FI614" — the IATA designator when there is one. */
  ident: string;
  airline: string;
  origin: FlightAirport;
  destination: FlightAirport;
  departure: FlightTimes;
  arrival: FlightTimes;
  gateOrigin: string;
  terminalOrigin: string;
  gateDestination: string;
  terminalDestination: string;
  baggageClaim: string;
  aircraftType: string;
  phase: FlightPhase;
  /** The provider's own status text ("En Route / On Time"). */
  status: string;
  /** "On time", "Delayed 25 min", "Cancelled" — this module's reading. */
  statusText: string;
  departureDelayMinutes?: number;
  arrivalDelayMinutes?: number;
  progressPercent?: number;
  /** "45%" when the flight is in the air. */
  progressText?: string;
  /** One sentence stating the flight, for grounding checks on the reply. */
  line: string;
}

export type FlightLookupResult =
  | { flight: FlightStatus; others?: Array<Pick<FlightStatus, 'id' | 'ident' | 'departure'>> }
  | { flight?: undefined; notFound: true; ident: string; message: string }
  | { flight?: undefined; error: string };

/**
 * A flight designator as people write it: "FI614", "FI 614", "ua-1", "BAW283",
 * "U2 8821". Two-character IATA airline codes may carry a digit; three-letter
 * ICAO codes may not.
 */
const DESIGNATOR = /^(?:[A-Z]{3}|[A-Z][A-Z0-9]|[0-9][A-Z])\d{1,4}[A-Z]?$/;

export function normalizeFlightIdent(value: string): string | undefined {
  const ident = value.toUpperCase().replace(/[\s-]+/g, '');
  return DESIGNATOR.test(ident) ? ident : undefined;
}

/** FlightAware ids are the designator, an epoch and a source tag. */
const FLIGHT_ID = /^[A-Z0-9]{2,8}-\d{9,12}-[a-z0-9:_-]{1,40}$/i;

export function isFlightId(value: string): boolean {
  return FLIGHT_ID.test(value);
}

export function clean(value: unknown, max = 80): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return (
    String(value)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
      .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
  );
}

/** A UTC instant as ISO 8601 on the airport's wall clock, offset included. */
export function zonedIso(utc: string, timeZone: string): string | undefined {
  const date = new Date(utc);
  if (!Number.isFinite(date.getTime())) return undefined;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    }).formatToParts(date);
  } catch {
    return zonedIso(utc, 'UTC');
  }
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  const zone = part('timeZoneName').replace(/^GMT/, '');
  const offset = zone === '' ? '+00:00' : zone;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}${offset}`;
}

type Raw = Record<string, unknown>;

function airport(value: unknown): FlightAirport {
  const raw = (value && typeof value === 'object' ? value : {}) as Raw;
  const code = clean(raw.code_iata, 4) || clean(raw.code, 8);
  const city = clean(raw.city, 60);
  const name = clean(raw.name, 80);
  const place = city || name;
  return {
    code,
    name,
    city,
    timeZone: clean(raw.timezone, 60),
    label: place && code ? `${place} (${code})` : place || code || 'Unknown',
  };
}

function times(raw: Raw, stem: 'out' | 'in', timeZone: string): FlightTimes {
  const read = (key: string) =>
    typeof raw[key] === 'string' ? zonedIso(raw[key] as string, timeZone) : undefined;
  const scheduled = read(`scheduled_${stem}`);
  const estimated = read(`estimated_${stem}`);
  const actual = read(`actual_${stem}`);
  const best = actual ?? estimated ?? scheduled;
  return {
    ...(scheduled ? { scheduled } : {}),
    ...(estimated ? { estimated } : {}),
    ...(actual ? { actual } : {}),
    ...(best ? { best } : {}),
  };
}

function phaseOf(raw: Raw): FlightPhase {
  if (raw.cancelled === true) return 'cancelled';
  if (raw.diverted === true) return 'diverted';
  if (raw.actual_in) return 'arrived';
  if (raw.actual_on) return 'landed';
  if (raw.actual_off) return 'en_route';
  if (raw.actual_out) return 'taxiing';
  return 'scheduled';
}

function minutes(seconds: unknown): number | undefined {
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? Math.round(seconds / 60)
    : undefined;
}

function statusText(phase: FlightPhase, delay: number | undefined): string {
  if (phase === 'cancelled') return 'Cancelled';
  if (phase === 'diverted') return 'Diverted';
  const late = delay !== undefined && delay >= 5;
  const early = delay !== undefined && delay <= -5;
  const timing = late ? `Delayed ${delay} min` : early ? `Early ${-delay} min` : 'On time';
  switch (phase) {
    case 'arrived':
      return late ? `Arrived ${delay} min late` : 'Arrived';
    case 'landed':
      return 'Landed';
    case 'en_route':
      return late ? `In the air, ${delay} min late` : 'In the air';
    case 'taxiing':
      return late ? `Left the gate ${delay} min late` : 'Left the gate';
    default:
      return timing;
  }
}

export function normalizeFlight(raw: Raw): FlightStatus | undefined {
  const id = clean(raw.fa_flight_id, 80);
  if (!id) return undefined;
  const origin = airport(raw.origin);
  const destination = airport(raw.destination);
  const phase = phaseOf(raw);
  const departureDelay = minutes(raw.departure_delay);
  const arrivalDelay = minutes(raw.arrival_delay);
  const delay = ['en_route', 'landed', 'arrived'].includes(phase)
    ? (arrivalDelay ?? departureDelay)
    : departureDelay;
  const progress =
    typeof raw.progress_percent === 'number' && phase === 'en_route'
      ? Math.max(0, Math.min(100, Math.round(raw.progress_percent)))
      : undefined;
  const ident = clean(raw.ident_iata, 10) || clean(raw.ident, 10);
  const flight: FlightStatus = {
    id,
    ident,
    airline: clean(raw.operator_iata, 4) || clean(raw.operator, 6),
    origin,
    destination,
    departure: times(raw, 'out', origin.timeZone),
    arrival: times(raw, 'in', destination.timeZone),
    gateOrigin: clean(raw.gate_origin, 8),
    terminalOrigin: clean(raw.terminal_origin, 8),
    gateDestination: clean(raw.gate_destination, 8),
    terminalDestination: clean(raw.terminal_destination, 8),
    baggageClaim: clean(raw.baggage_claim, 12),
    aircraftType: clean(raw.aircraft_type, 8),
    phase,
    status: clean(raw.status, 60),
    statusText: statusText(phase, delay),
    ...(departureDelay !== undefined ? { departureDelayMinutes: departureDelay } : {}),
    ...(arrivalDelay !== undefined ? { arrivalDelayMinutes: arrivalDelay } : {}),
    ...(progress !== undefined ? { progressPercent: progress, progressText: `${progress}%` } : {}),
    line: '',
  };
  flight.line = [
    `${ident} ${origin.label} to ${destination.label}`,
    flight.statusText,
    flight.departure.best ? `departs ${flight.departure.best}` : '',
    flight.arrival.best ? `arrives ${flight.arrival.best}` : '',
    flight.gateOrigin ? `gate ${flight.gateOrigin}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return flight;
}

/** The owner-local calendar date a flight leaves on, in its origin's zone. */
function departureDate(flight: FlightStatus): string {
  return (flight.departure.scheduled ?? flight.departure.best ?? '').slice(0, 10);
}

/**
 * Which of an ident's ~two weeks of flights the owner means. A named date
 * picks that day's departure. Otherwise: the one in the air, else the next to
 * leave (counting one that left the gate up to three hours ago as not yet
 * over), else the most recent.
 */
export function pickFlight(
  flights: FlightStatus[],
  options: { date?: string; now: Date },
): FlightStatus[] {
  if (options.date) return flights.filter((flight) => departureDate(flight) === options.date);
  const active = flights.filter((flight) =>
    ['taxiing', 'en_route', 'landed'].includes(flight.phase),
  );
  if (active.length) return active.slice(0, 1);
  const now = options.now.getTime();
  const at = (flight: FlightStatus) => Date.parse(flight.departure.best ?? '') || 0;
  const upcoming = flights
    .filter((flight) => flight.phase === 'scheduled' || flight.phase === 'cancelled')
    .filter((flight) => at(flight) >= now - 3 * 60 * 60 * 1000)
    .sort((a, b) => at(a) - at(b));
  if (upcoming[0]) return [upcoming[0]];
  const recent = [...flights].sort((a, b) => at(b) - at(a));
  return recent.slice(0, 1);
}

const cache = new Map<string, { at: number; value: unknown }>();
const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 200;

/** Test seam: forget cached provider responses. */
export function clearFlightsCache(): void {
  cache.clear();
}

async function getJson(
  url: string,
  apiKey: string,
  options: { fetchImpl?: FlightsFetch; signal?: AbortSignal },
): Promise<{ status: number; body: unknown }> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { status: 200, body: hit.value };
  const fetchImpl = options.fetchImpl ?? (fetch as FlightsFetch);
  const response = await fetchImpl(url, {
    headers: { 'x-apikey': apiKey, accept: 'application/json' },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) return { status: response.status, body: undefined };
  const body = (await response.json()) as unknown;
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(url, { at: Date.now(), value: body });
  return { status: 200, body };
}

function flightsOf(body: unknown): FlightStatus[] {
  const list = (body as { flights?: unknown } | undefined)?.flights;
  return Array.isArray(list)
    ? list.flatMap((item) =>
        item && typeof item === 'object' ? (normalizeFlight(item as Raw) ?? []) : [],
      )
    : [];
}

export async function lookupFlight(input: {
  apiKey: string;
  ident: string;
  /** Departure date in the origin's zone, YYYY-MM-DD. */
  date?: string;
  now: Date;
  fetchImpl?: FlightsFetch;
  signal?: AbortSignal;
}): Promise<FlightLookupResult> {
  const ident = normalizeFlightIdent(input.ident);
  if (!ident)
    return { error: `"${clean(input.ident, 20)}" is not a flight number (like FI614 or UA 1).` };
  const url = `${AEROAPI_BASE}/flights/${encodeURIComponent(ident)}?ident_type=designator`;
  const { status, body } = await getJson(url, input.apiKey, input);
  if (status === 404 || (status === 200 && flightsOf(body).length === 0))
    return {
      notFound: true,
      ident,
      message: `FlightAware has no ${ident} in the last ten days or the next two.`,
    };
  if (status !== 200) return { error: `FlightAware answered ${status}.` };
  const flights = flightsOf(body);
  const picked = pickFlight(flights, {
    now: input.now,
    ...(input.date ? { date: input.date } : {}),
  });
  const [flight, ...rest] = picked;
  if (!flight)
    return {
      notFound: true,
      ident,
      message: `FlightAware has no ${ident} leaving on ${input.date}.`,
    };
  return rest.length
    ? { flight, others: rest.map(({ id, ident, departure }) => ({ id, ident, departure })) }
    : { flight };
}

/** The live half: one known flight, read again by its FlightAware id. */
export async function fetchFlightById(input: {
  apiKey: string;
  id: string;
  fetchImpl?: FlightsFetch;
  signal?: AbortSignal;
}): Promise<FlightStatus | undefined> {
  if (!isFlightId(input.id)) return undefined;
  const url = `${AEROAPI_BASE}/flights/${encodeURIComponent(input.id)}?ident_type=fa_flight_id`;
  const { status, body } = await getJson(url, input.apiKey, input);
  if (status !== 200) throw new Error(`FlightAware answered ${status}`);
  // A diverted flight comes back twice under one id; the diversion is last.
  return flightsOf(body).at(-1);
}

/**
 * How often a client should read a flight again, and until when it is worth
 * reading at all. Sparse far from departure, tight around the moments that
 * change (boarding, pushback, landing), done once the flight is at the gate.
 */
export function flightLivePolicy(
  flight: FlightStatus,
  now: Date,
): { pollSeconds: number; until: string } | undefined {
  if (['arrived', 'cancelled'].includes(flight.phase)) return undefined;
  const arrive = Date.parse(flight.arrival.best ?? '');
  const depart = Date.parse(flight.departure.best ?? '');
  const until = new Date(
    Number.isFinite(arrive) ? arrive + 60 * 60 * 1000 : now.getTime() + 12 * 60 * 60 * 1000,
  );
  if (until.getTime() <= now.getTime()) return undefined;
  const toDeparture = Number.isFinite(depart) ? depart - now.getTime() : 0;
  const pollSeconds =
    flight.phase === 'scheduled'
      ? toDeparture > 6 * 60 * 60 * 1000
        ? 1800
        : toDeparture > 90 * 60 * 1000
          ? 600
          : 120
      : flight.phase === 'en_route'
        ? 300
        : 120;
  return { pollSeconds, until: until.toISOString() };
}
