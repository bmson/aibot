import { type Db, deviceTokens } from '@assistant/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

/**
 * APNs device-token registry. The iOS app registers on launch and whenever
 * APNs rotates its token; the push module reads the active rows to deliver
 * owner-facing notices. Tokens are platform plumbing, not content — they live
 * in core so both the web ingest route and the agent's push module share one
 * store without either importing the other.
 */

export const DeviceTokenRegistrationSchema = z.object({
  token: z
    .string()
    .regex(/^[0-9a-f]{64,}$/i, 'device token is a hex string')
    .max(256),
  platform: z.literal('ios').default('ios'),
  /** Which APNs host minted the token; the app knows from its own build. */
  environment: z.enum(['sandbox', 'production']).default('production'),
});
export type DeviceTokenRegistration = z.infer<typeof DeviceTokenRegistrationSchema>;

/** Idempotent: re-registering the same token refreshes it and revives an invalidated row. */
export async function upsertDeviceToken(
  db: Db,
  agentId: string,
  registration: DeviceTokenRegistration,
): Promise<void> {
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
}

export interface ActiveDeviceToken {
  token: string;
  environment: 'sandbox' | 'production';
}

/** Deliverable tokens for one agent, oldest first so a replaced token loses ties. */
export async function listActiveDeviceTokens(
  db: Db,
  agentId: string,
): Promise<ActiveDeviceToken[]> {
  const rows = await db
    .select({ token: deviceTokens.token, environment: deviceTokens.environment })
    .from(deviceTokens)
    .where(and(eq(deviceTokens.agentId, agentId), isNull(deviceTokens.invalidatedAt)))
    .orderBy(asc(deviceTokens.lastSeenAt));
  return rows.map((row) => ({
    token: row.token,
    environment: row.environment === 'sandbox' ? 'sandbox' : 'production',
  }));
}

/** APNs said Unregistered (410): stop sending to the token, but keep the row. */
export async function invalidateDeviceToken(db: Db, token: string): Promise<void> {
  await db
    .update(deviceTokens)
    .set({ invalidatedAt: new Date() })
    .where(eq(deviceTokens.token, token));
}
