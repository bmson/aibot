import type { FlightStatus } from './aeroapi.js';

/**
 * A followed flight's Lock Screen state, as the server pushes it. The shape is
 * the iOS `FlightActivityAttributes.ContentState` exactly — plain numbers for
 * every time, because ActivityKit decodes pushed JSON with a default decoder
 * and a `Date` would not survive the trip. Keys absent here decode as nil.
 */
export interface FlightActivityState {
  phase: string;
  statusText: string;
  departEpoch?: number;
  departOffset?: number;
  arriveEpoch?: number;
  arriveOffset?: number;
  gate: string;
  terminal: string;
  arrivalGate: string;
  baggage: string;
  progress?: number;
  updatedEpoch: number;
}

/** "…+00:00" or "…-04:00" → seconds east of UTC. */
function offsetSeconds(iso: string): number | undefined {
  if (iso.endsWith('Z')) return 0;
  const match = /([+-])(\d{2}):?(\d{2})$/.exec(iso);
  if (!match) return undefined;
  const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60;
  return match[1] === '-' ? -seconds : seconds;
}

function instant(iso: string | undefined): { epoch?: number; offset?: number } {
  if (!iso) return {};
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return {};
  const offset = offsetSeconds(iso);
  return { epoch: ms / 1000, ...(offset !== undefined ? { offset } : {}) };
}

export function flightActivityState(flight: FlightStatus, now: Date): FlightActivityState {
  const depart = instant(flight.departure.best);
  const arrive = instant(flight.arrival.best);
  return {
    phase: flight.phase,
    statusText: flight.statusText,
    ...(depart.epoch !== undefined ? { departEpoch: depart.epoch } : {}),
    ...(depart.offset !== undefined ? { departOffset: depart.offset } : {}),
    ...(arrive.epoch !== undefined ? { arriveEpoch: arrive.epoch } : {}),
    ...(arrive.offset !== undefined ? { arriveOffset: arrive.offset } : {}),
    gate: flight.gateOrigin,
    terminal: flight.terminalOrigin,
    arrivalGate: flight.gateDestination,
    baggage: flight.baggageClaim,
    ...(flight.progressPercent !== undefined
      ? { progress: Math.min(Math.max(flight.progressPercent / 100, 0), 1) }
      : {}),
    updatedEpoch: Math.floor(now.getTime() / 1000),
  };
}

/**
 * What the owner would see change, without the clock of the read itself — two
 * reads a minute apart that say the same thing send no push.
 */
export function flightStateFingerprint(state: FlightActivityState): string {
  const { updatedEpoch: _updated, ...seen } = state;
  return JSON.stringify(seen, Object.keys(seen).sort());
}

/** The facts an alert compares, kept in the watch between reads. */
export interface FlightAlertBasis {
  phase: string;
  gate: string;
  terminal: string;
  arrivalGate: string;
  delayMinutes?: number;
}

export function flightAlertBasis(flight: FlightStatus): FlightAlertBasis {
  const inAir = ['en_route', 'landed', 'arrived'].includes(flight.phase);
  const delay = inAir
    ? (flight.arrivalDelayMinutes ?? flight.departureDelayMinutes)
    : flight.departureDelayMinutes;
  return {
    phase: flight.phase,
    gate: flight.gateOrigin,
    terminal: flight.terminalOrigin,
    arrivalGate: flight.gateDestination,
    ...(delay !== undefined ? { delayMinutes: delay } : {}),
  };
}

/**
 * The changes worth lighting the screen for, as opposed to a silent update:
 * a new gate, a cancellation or diversion, a delay that grew by a quarter of
 * an hour. A first read has nothing to compare with and never alerts.
 */
export function flightAlert(
  ident: string,
  prior: FlightAlertBasis | undefined,
  next: FlightAlertBasis,
): { title: string; body: string } | undefined {
  if (!prior) return undefined;
  if (next.phase === 'cancelled' && prior.phase !== 'cancelled')
    return { title: `${ident} cancelled`, body: 'The airline has cancelled this flight.' };
  if (next.phase === 'diverted' && prior.phase !== 'diverted')
    return { title: `${ident} diverted`, body: 'This flight is heading to a different airport.' };
  const departing = !['en_route', 'landed', 'arrived'].includes(next.phase);
  if (departing && next.gate && prior.gate && next.gate !== prior.gate)
    return { title: `${ident} gate change`, body: `Now departing from gate ${next.gate}.` };
  if (departing && next.terminal && prior.terminal && next.terminal !== prior.terminal)
    return {
      title: `${ident} terminal change`,
      body: `Now departing from terminal ${next.terminal}.`,
    };
  if (!departing && next.arrivalGate && next.arrivalGate !== prior.arrivalGate)
    return { title: `${ident} arrival gate`, body: `Arriving at gate ${next.arrivalGate}.` };
  const was = prior.delayMinutes ?? 0;
  const now = next.delayMinutes ?? 0;
  if (now - was >= 15)
    return { title: `${ident} delayed`, body: `Now running ${now} minutes late.` };
  return undefined;
}
