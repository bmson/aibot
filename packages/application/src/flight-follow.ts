import { isFlightId } from '@assistant/core/flights';
import type { WatchRepository } from '@assistant/persistence';
import { z } from 'zod';

/**
 * The phone following a flight on the Lock Screen. Its Live Activity hands
 * over a push token, and this files a `flight` watch holding it, which the
 * flights module's sweep reads again and pushes to until the flight is at the
 * gate (modules/flights/follow.ts). Following again — a rotated token, a
 * reinstall — replaces the flight's watch rather than adding a second.
 */

const FollowSchema = z.object({
  flightId: z.string().refine(isFlightId, 'not a FlightAware flight id'),
  ident: z.string().trim().min(1).max(12),
  pushToken: z.string().regex(/^[0-9a-f]{16,512}$/i),
  environment: z.enum(['sandbox', 'production']),
  /** When the card stops being live; the watch ends then too. */
  until: z.string().datetime({ offset: true }).optional(),
});

const UnfollowSchema = z.object({
  flightId: z.string().refine(isFlightId, 'not a FlightAware flight id'),
});

export type FlightFollowResult =
  | { ok: true; watchId?: string }
  | { ok: false; status: 400; error: string };

export interface FlightFollowDeps {
  watches: WatchRepository;
  agentId: string;
  /** Where the watch lives in the chat list: the owner's primary chat. */
  conversationId: string | null;
}

const HOUR_MS = 60 * 60 * 1000;
/** A flight is followed at most two days ahead plus the longest flight. */
const MAX_FOLLOW_MS = 72 * HOUR_MS;

async function followedWatches(deps: FlightFollowDeps, flightId: string) {
  const active = await deps.watches.list(deps.agentId, 'active', 100);
  return active.filter(
    (watch) =>
      watch.kind === 'flight' &&
      (watch.match as { flightId?: unknown } | null)?.flightId === flightId,
  );
}

export async function followFlight(
  deps: FlightFollowDeps,
  body: unknown,
  now = new Date(),
): Promise<FlightFollowResult> {
  const parsed = FollowSchema.safeParse(body);
  if (!parsed.success) return { ok: false, status: 400, error: 'invalid flight follow' };
  const { flightId, ident, pushToken, environment, until } = parsed.data;
  for (const watch of await followedWatches(deps, flightId))
    await deps.watches.cancel(deps.agentId, watch.id, now);
  const requested = until ? Date.parse(until) : now.getTime() + 24 * HOUR_MS;
  const expiresAt = new Date(
    Math.min(Math.max(requested, now.getTime() + HOUR_MS), now.getTime() + MAX_FOLLOW_MS),
  );
  const watch = await deps.watches.create({
    agentId: deps.agentId,
    conversationId: deps.conversationId,
    kind: 'flight',
    tier: 'notify',
    name: `${ident} on the Lock Screen`,
    match: { flightId, ident },
    maxFires: null,
    expiresAt,
    // The phone has just drawn this flight; the first server read can wait.
    nextPollAt: new Date(now.getTime() + 60_000),
    pollIntervalSeconds: 120,
    state: { pushToken, environment },
  });
  return { ok: true, watchId: watch.id };
}

export async function unfollowFlight(
  deps: FlightFollowDeps,
  body: unknown,
  now = new Date(),
): Promise<FlightFollowResult> {
  const parsed = UnfollowSchema.safeParse(body);
  if (!parsed.success) return { ok: false, status: 400, error: 'invalid flight' };
  for (const watch of await followedWatches(deps, parsed.data.flightId))
    await deps.watches.cancel(deps.agentId, watch.id, now);
  return { ok: true };
}
