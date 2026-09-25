import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresDeviceTokenRepository } from './device-token-repository.js';
import { agents, deviceTokens } from './schema.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:55432/assistant_test';

describe('PostgreSQL device tokens', () => {
  const agentIds = [randomUUID(), randomUUID()];
  const token = randomUUID().replaceAll('-', '').repeat(2);
  let db: Db;
  let dbUp = false;

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      await db.select({ id: agents.id }).from(agents).limit(1);
      dbUp = true;
    } catch {
      console.warn('device-token-repository.test: database unreachable — skipping');
      return;
    }
    await db.insert(agents).values(
      agentIds.map((id) => ({
        id,
        name: 'Device owner',
        email: `${id}@test.local`,
        workspacePrefix: `tests/${id}`,
      })),
    );
  });

  afterAll(async () => {
    if (!dbUp) return;
    await db.delete(deviceTokens).where(eq(deviceTokens.token, token));
    await db.delete(agents).where(inArray(agents.id, agentIds));
  });

  it('upserts by token, moves it to the registering agent, and revives it', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const repository = createPostgresDeviceTokenRepository(db);
    await repository.register(agentIds[0] as string, {
      token,
      platform: 'ios',
      environment: 'sandbox',
    });
    await db
      .update(deviceTokens)
      .set({ invalidatedAt: new Date() })
      .where(eq(deviceTokens.token, token));
    await repository.register(agentIds[1] as string, {
      token,
      platform: 'ios',
      environment: 'production',
    });
    const rows = await db.select().from(deviceTokens).where(eq(deviceTokens.token, token));
    expect(rows).toEqual([
      expect.objectContaining({
        agentId: agentIds[1],
        environment: 'production',
        invalidatedAt: null,
      }),
    ]);
  });
});
