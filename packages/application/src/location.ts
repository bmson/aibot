import { getAgent } from '@assistant/core/chat';
import {
  LocationPingSchema,
  locationPingFresh,
  recordLocationPing,
} from '@assistant/core/memory/location';
import type { Db } from '@assistant/db';

export type LocationPingResult = { ok: true } | { ok: false; error: string; status: 400 | 409 };

/**
 * The native app's location ingest (the agent-service webhook serves iOS
 * Shortcuts behind an HMAC secret; the app authenticates with its mobile
 * bearer token instead). Same transient semantics either way: the embedded
 * capturedAt is required and freshness-checked, so a delayed or replayed call
 * can never re-assert an old position as the owner's current one.
 */
export async function recordOwnerLocationPing(db: Db, body: unknown): Promise<LocationPingResult> {
  const parsed = LocationPingSchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: 'invalid ping', status: 400 };
  if (!locationPingFresh(parsed.data)) return { ok: false, error: 'stale ping', status: 409 };
  const agent = await getAgent(db);
  await recordLocationPing(db, agent.id, parsed.data);
  return { ok: true };
}
