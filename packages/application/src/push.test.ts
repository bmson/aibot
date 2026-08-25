import { createDb, type Db, deviceTokens } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerDeviceToken } from './push.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

const XTEST_TOKEN = 'ab'.repeat(32);

describe('registerDeviceToken (integration)', () => {
  let db: Db;
  let dbUp = false;

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      await db.delete(deviceTokens).where(eq(deviceTokens.token, XTEST_TOKEN));
      dbUp = true;
    } catch {
      console.warn('application/push.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp) await db.delete(deviceTokens).where(eq(deviceTokens.token, XTEST_TOKEN));
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  it('registers a token and revives it idempotently on re-register', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await registerDeviceToken(db, {
      token: XTEST_TOKEN,
      platform: 'ios',
      environment: 'sandbox',
    });
    expect(result).toEqual({ ok: true });

    const rows = await db.select().from(deviceTokens).where(eq(deviceTokens.token, XTEST_TOKEN));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.environment).toBe('sandbox');
    expect(rows[0]?.invalidatedAt).toBeNull();

    // A re-registration (app relaunch) updates in place — never a second row.
    const again = await registerDeviceToken(db, {
      token: XTEST_TOKEN,
      platform: 'ios',
      environment: 'production',
    });
    expect(again).toEqual({ ok: true });
    const after = await db.select().from(deviceTokens).where(eq(deviceTokens.token, XTEST_TOKEN));
    expect(after).toHaveLength(1);
    expect(after[0]?.environment).toBe('production');
  });

  it('rejects a malformed token', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await registerDeviceToken(db, { token: 'not-hex' });
    expect(result).toEqual({ ok: false, error: 'invalid device token', status: 400 });
  });
});
