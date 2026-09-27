import { loadConfig } from '@assistant/config';
import {
  type FlightLive,
  type FlightStatus,
  type FlightsFetch,
  fetchFlightById,
  flightCardSpec,
  flightLive,
  isFlightId,
} from '@assistant/core/flights';
import type { GenerativeCardSpecV1 } from '@assistant/core/generative-card';

/**
 * The live half of a flight card: read one flight again, straight from
 * FlightAware, with no model and no task, and recompile its card. The phone
 * calls this while the card is on screen, and to keep a flight's Lock Screen
 * activity current while the app is open.
 *
 * Only a FlightAware flight id is accepted, and it is checked against the
 * id's own shape before it reaches the provider's fixed path.
 */

export type LiveFlightResult =
  | {
      ok: true;
      fetchedAt: string;
      spec: GenerativeCardSpecV1;
      /** Always sent, so a followed flight's last state reaches the Lock Screen. */
      flight: FlightStatus;
      /** Absent once the flight is at the gate or cancelled: stop polling. */
      live?: FlightLive;
    }
  | { ok: false; status: 400 | 404 | 502 | 503; error: string };

export async function refreshLiveFlight(
  id: string | null,
  options: { apiKey?: string; now?: Date; fetchImpl?: FlightsFetch } = {},
): Promise<LiveFlightResult> {
  if (!id || !isFlightId(id)) return { ok: false, status: 400, error: 'invalid flight id' };
  const apiKey = options.apiKey ?? loadConfig().AEROAPI_KEY;
  if (!apiKey) return { ok: false, status: 503, error: 'Flight status is not set up.' };
  const now = options.now ?? new Date();
  try {
    const flight = await fetchFlightById({
      apiKey,
      id,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (!flight) return { ok: false, status: 404, error: 'FlightAware no longer has that flight.' };
    const spec = flightCardSpec(flight, JSON.stringify({ flight }));
    if (!spec) return { ok: false, status: 502, error: 'The flight could not be drawn.' };
    const live = flightLive(flight, now);
    return { ok: true, fetchedAt: now.toISOString(), spec, flight, ...(live ? { live } : {}) };
  } catch (error) {
    console.error('live flight refresh failed', error);
    return { ok: false, status: 502, error: 'FlightAware could not be reached.' };
  }
}
