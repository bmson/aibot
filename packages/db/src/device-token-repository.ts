import type { DeviceTokenRepository } from '@assistant/persistence';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from './client.js';
import { deviceTokens } from './schema.js';

/** Upsert on the unique token, exactly as the push registry has always done. */
export function createPostgresDeviceTokenRepository(db: Db): DeviceTokenRepository {
  return {
    kind: 'device-token-repository',
    async register(agentId, registration) {
      await db
        .insert(deviceTokens)
        .values({
          agentId,
          token: registration.token,
          platform: registration.platform,
          environment: registration.environment,
          lastSeenAt: new Date(),
        })
        .onConflictDoUpdate({
          target: deviceTokens.token,
          set: {
            agentId,
            environment: registration.environment,
            lastSeenAt: new Date(),
            invalidatedAt: null,
          },
        });
    },
    async listActive(agentId) {
      const rows = await db
        .select({ token: deviceTokens.token, environment: deviceTokens.environment })
        .from(deviceTokens)
        .where(and(eq(deviceTokens.agentId, agentId), isNull(deviceTokens.invalidatedAt)))
        .orderBy(asc(deviceTokens.lastSeenAt));
      return rows.map((row) => ({
        token: row.token,
        environment: row.environment === 'sandbox' ? 'sandbox' : 'production',
      }));
    },
    async invalidate(token) {
      await db
        .update(deviceTokens)
        .set({ invalidatedAt: new Date() })
        .where(eq(deviceTokens.token, token));
    },
  };
}
