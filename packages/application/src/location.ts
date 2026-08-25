import { getAgent } from '@assistant/core/chat';
import {
  LocationPingSchema,
  locationPingFresh,
  recordLocationPing,
} from '@assistant/core/memory/location';
import { maybeEnqueueArrivalNudge } from '@assistant/core/proactive/arrival';
import type { Db } from '@assistant/db';

export type LocationPingResult = { ok: true } | { ok: false; error: string; status: 400 | 409 };

/**
 * The native app's location ingest (the agent-service webhook serves iOS
 * Shortcuts behind an HMAC secret; the app authenticates with its mobile
 * bearer token instead). Same transient semantics either way: the embedded
 * capturedAt is required and freshness-checked, so a delayed or replayed call
 * can never re-assert an old position as the owner's current one.
 *
 * A recorded ping also feeds the arrival hook: somewhere genuinely new may
 * earn one considered nudge (bounded in core/proactive/arrival). The hook is
 * best-effort — the ping is the payload, the nudge a bonus.
 */
export async function recordOwnerLocationPing(db: Db, body: unknown): Promise<LocationPingResult> {
  const parsed = LocationPingSchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: 'invalid ping', status: 400 };
  if (!locationPingFresh(parsed.data)) return { ok: false, error: 'stale ping', status: 409 };
  const agent = await getAgent(db);
  await recordLocationPing(db, agent.id, parsed.data);
  await maybeEnqueueArrivalNudge(db, agent, {
    lat: parsed.data.lat,
    lng: parsed.data.lng,
    label: parsed.data.label,
    accuracyM: parsed.data.accuracyM,
    capturedAt: new Date(parsed.data.capturedAt ?? Date.now()),
  }).catch((err) => console.error('location: arrival hook failed', err));
  return { ok: true };
}
