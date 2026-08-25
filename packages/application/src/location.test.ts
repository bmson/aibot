import { createDb, type Db, locationPings, tasks } from '@assistant/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordOwnerLocationPing } from './location.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

describe('recordOwnerLocationPing (integration)', () => {
  let db: Db;
  let dbUp = false;

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      await db.delete(locationPings).where(eq(locationPings.source, 'xtest-app'));
      dbUp = true;
    } catch {
      console.warn('application/location.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp) await db.delete(locationPings).where(eq(locationPings.source, 'xtest-app'));
    // The ping ingest path also runs the arrival hook — drop any nudge task
    // a test ping happened to arm.
    if (dbUp) {
      await db.delete(tasks).where(sql`${tasks.externalEventId} like 'arrival:%'`);
    }
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  it('records a fresh, valid ping with its device time zone', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await recordOwnerLocationPing(db, {
      lat: 64.1466,
      lng: -21.9426,
      label: 'Reykjavík',
      accuracyM: 20,
      source: 'xtest-app',
      timeZone: 'Atlantic/Reykjavik',
      capturedAt: new Date().toISOString(),
    });
    expect(result).toEqual({ ok: true });
    const rows = await db.select().from(locationPings).where(eq(locationPings.source, 'xtest-app'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.timeZone).toBe('Atlantic/Reykjavik');
  });

  it('rejects an invalid body and a stale capturedAt', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const invalid = await recordOwnerLocationPing(db, { lat: 999 });
    expect(invalid).toEqual({ ok: false, error: 'invalid ping', status: 400 });
    const stale = await recordOwnerLocationPing(db, {
      lat: 64.1466,
      lng: -21.9426,
      label: '',
      source: 'xtest-app',
      capturedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    expect(stale).toEqual({ ok: false, error: 'stale ping', status: 409 });
  });
});
