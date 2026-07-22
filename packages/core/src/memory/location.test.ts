import { createHmac } from 'node:crypto';
import { createDb, type Db, locationPings } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import {
  formatLocationLine,
  latestLocation,
  purgeStaleLocations,
  recordLocationPing,
  verifyLocationSignature,
} from './location.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

describe('location context — pure helpers', () => {
  it('verifies an HMAC signature and rejects forged/unsigned/secretless pings', () => {
    const secret = 'shortcut-secret';
    const body = JSON.stringify({ lat: 64.1466, lng: -21.9426 });
    const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(verifyLocationSignature(secret, body, sig)).toBe(true);
    expect(verifyLocationSignature(secret, body, sig.toUpperCase())).toBe(true); // case-insensitive
    expect(verifyLocationSignature(secret, body, 'deadbeef')).toBe(false);
    expect(verifyLocationSignature(secret, `${body} `, sig)).toBe(false); // body tampered
    expect(verifyLocationSignature(secret, body, null)).toBe(false);
    expect(verifyLocationSignature('', body, sig)).toBe(false); // ingest disabled
  });

  it('formats an ambient location line, or nothing when there is no ping', () => {
    expect(formatLocationLine(null)).toBeUndefined();
    const now = new Date('2026-07-21T12:00:00Z');
    const line = formatLocationLine(
      {
        id: 'x',
        agentId: 'a',
        lat: '64.146600',
        lng: '-21.942600',
        label: 'Reykjavík',
        accuracyM: 20,
        source: 'shortcut',
        capturedAt: new Date('2026-07-21T11:48:00Z'),
        createdAt: now,
      },
      now,
    );
    expect(line).toContain('near Reykjavík');
    expect(line).toContain('64.1466, -21.9426');
    expect(line).toContain('12 min ago');
  });
});

describe('location context — storage', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;

  async function cleanup() {
    await db.delete(locationPings).where(eq(locationPings.source, 'xtest'));
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
      await cleanup();
    } catch {
      console.warn('location.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp) await cleanup();
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  it('records a ping, returns the freshest within window, and purges stale ones', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // A stale ping (2 days ago) and a fresh one (now).
    await recordLocationPing(db, agentId, {
      lat: 40,
      lng: -74,
      label: 'old',
      source: 'xtest',
      capturedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
    });
    const fresh = await recordLocationPing(db, agentId, {
      lat: 64.1466,
      lng: -21.9426,
      label: 'Reykjavík',
      source: 'xtest',
      capturedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    const latest = await latestLocation(db, agentId, 1);
    expect(latest?.id).toBe(fresh.id);
    expect(latest?.label).toBe('Reykjavík');

    // With a 1-day window, the 2-day-old ping is stale and purged; the fresh one stays.
    const purged = await purgeStaleLocations(db, 1);
    expect(purged).toBeGreaterThanOrEqual(1);
    const rows = await db.select().from(locationPings).where(eq(locationPings.source, 'xtest'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(fresh.id);

    // Narrowing the window (~1.4 min) past the 10-min-old ping yields nothing.
    const none = await latestLocation(db, agentId, 0.001);
    expect(none).toBeNull();
  });
});
