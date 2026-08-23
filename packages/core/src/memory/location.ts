import { createHmac, timingSafeEqual } from 'node:crypto';
import { type Db, type LocationPingRow, locationPings } from '@assistant/db';
import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';

/**
 * Location context (Phase 15). The owner's phone (an iOS Shortcut or the native
 * app) POSTs an HMAC-signed location ping; it lands here as a deliberately
 * transient row — never long-term location history. The sweep purges anything
 * older than the retention window, and location never enters the semantic
 * memory/embedding space or memory extraction. The latest fresh ping is
 * surfaced as ambient context to the owner's own (non-tainted) prompts.
 */

export const LocationPingSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  label: z.string().max(120).default(''),
  accuracyM: z.number().int().min(0).max(100_000).optional(),
  /** ISO timestamp of capture; defaults to receipt time. */
  capturedAt: z.string().datetime().optional(),
  source: z.string().max(40).default('shortcut'),
  /** IANA time zone id of the sending device — the owner's clock when traveling. */
  timeZone: z.string().max(64).optional(),
});
export type LocationPingInput = z.infer<typeof LocationPingSchema>;

/**
 * Verify an HMAC-SHA256 signature (hex) over the exact raw request body. A
 * missing secret (ingest disabled) or any mismatch fails closed. Constant-time
 * comparison over equal-length hex, so a forged or unsigned ping is rejected.
 */
export function verifyLocationSignature(
  secret: string,
  rawBody: string,
  signature: string | null | undefined,
): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim().toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Replay guard: the HMAC covers only the body, so a captured signed ping stays
 * valid forever unless its embedded timestamp is checked. `capturedAt` is the
 * only varying field that binds a ping to a moment, so it is REQUIRED here: a
 * ping without it is rejected (fail closed). Accepting a timestamp-less ping
 * and stamping it with receipt time would let a captured body be replayed hours
 * later and re-assert a stale location AS the owner's current one. The owner's
 * Shortcut must include a current-date field in the signed body (see
 * docs/operations.md).
 */
export const LOCATION_PING_MAX_SKEW_MS = 5 * 60 * 1000;

export function locationPingFresh(input: LocationPingInput, now = new Date()): boolean {
  if (!input.capturedAt) return false;
  return (
    Math.abs(now.getTime() - new Date(input.capturedAt).getTime()) <= LOCATION_PING_MAX_SKEW_MS
  );
}

export async function recordLocationPing(
  db: Db,
  agentId: string,
  input: LocationPingInput,
): Promise<LocationPingRow> {
  const [row] = await db
    .insert(locationPings)
    .values({
      agentId,
      lat: String(input.lat),
      lng: String(input.lng),
      label: input.label ?? '',
      accuracyM: input.accuracyM,
      source: input.source ?? 'shortcut',
      timeZone: input.timeZone ?? null,
      capturedAt: input.capturedAt ? new Date(input.capturedAt) : new Date(),
    })
    .returning();
  if (!row) throw new Error('failed to record location ping');
  return row;
}

/** The most recent ping within the retention window, or null if none is fresh. */
export async function latestLocation(
  db: Db,
  agentId: string,
  withinDays: number,
  /** Narrow to one ingest source (tests scope to their own rows this way). */
  source?: string,
): Promise<LocationPingRow | null> {
  const cutoff = new Date(Date.now() - withinDays * 24 * 3600 * 1000);
  const [row] = await db
    .select()
    .from(locationPings)
    .where(
      and(
        eq(locationPings.agentId, agentId),
        gte(locationPings.capturedAt, cutoff),
        source ? eq(locationPings.source, source) : undefined,
      ),
    )
    .orderBy(desc(locationPings.capturedAt))
    .limit(1);
  return row ?? null;
}

/** Delete pings older than the retention window (called from the sweep). */
export async function purgeStaleLocations(
  db: Db,
  retentionDays: number,
  batch = 500,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000);
  const stale = db
    .select({ id: locationPings.id })
    .from(locationPings)
    .where(lt(locationPings.capturedAt, cutoff))
    .limit(batch);
  const deleted = await db
    .delete(locationPings)
    .where(inArray(locationPings.id, stale))
    .returning({ id: locationPings.id });
  return deleted.length;
}

/** Minutes/hours-ago phrasing for the ambient line. */
function ago(from: Date, now: Date): string {
  const mins = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
}

/**
 * A single ambient line for the owner's system prompt, e.g.
 * "Owner's current location: near Reykjavík (64.1466, -21.9426), as of 12 min ago."
 * When the ping carries the device's time zone, the line also anchors "what time
 * is it for me" while the owner travels away from the agent's home zone.
 * Returns undefined when there is no fresh ping.
 */
export function formatLocationLine(
  ping: LocationPingRow | null,
  now = new Date(),
): string | undefined {
  if (!ping) return undefined;
  const place = ping.label ? `near ${ping.label} ` : '';
  const coords = `${Number(ping.lat).toFixed(4)}, ${Number(ping.lng).toFixed(4)}`;
  const zone = ping.timeZone ? ` The owner's device clock is in ${ping.timeZone}.` : '';
  return `Owner's current location: ${place}(${coords}), as of ${ago(ping.capturedAt, now)}.${zone} Use it for "where am I", nearby suggestions, and travel/timezone awareness; it is transient context, not a stored fact.`;
}
