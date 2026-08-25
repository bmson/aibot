import { getAgent } from '@assistant/core/chat';
import { DeviceTokenRegistrationSchema, upsertDeviceToken } from '@assistant/core/push/devices';
import type { Db } from '@assistant/db';

export type DeviceTokenResult = { ok: true } | { ok: false; error: string; status: 400 };

/**
 * The native app registering its APNs token (on every launch and whenever APNs
 * rotates it). Idempotent by token: a reinstall or a token that was invalidated
 * by a 410 simply comes back active. The push module reads these rows when it
 * fans a notice out to the owner's devices.
 */
export async function registerDeviceToken(db: Db, body: unknown): Promise<DeviceTokenResult> {
  const parsed = DeviceTokenRegistrationSchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: 'invalid device token', status: 400 };
  const agent = await getAgent(db);
  await upsertDeviceToken(db, agent.id, parsed.data);
  return { ok: true };
}
