import type { DeviceTokenRepository } from '@assistant/persistence';
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
  };
}
