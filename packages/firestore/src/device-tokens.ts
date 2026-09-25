import { createHash } from 'node:crypto';
import type { DeviceTokenRegistrationInput, DeviceTokenRepository } from '@assistant/persistence';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { documentKey, encodeRecord, type InstallationStore } from './store.js';

/**
 * New registrations use a token-derived ID so two concurrent first
 * registrations collide on create. Imported PostgreSQL rows keep their random
 * IDs and are found by the unique `token` field first.
 */
function deviceTokenId(token: string): string {
  const hex = createHash('sha256').update(`assistant:device-token:${token}`).digest('hex');
  const value = `${hex.slice(0, 12)}5${hex.slice(13, 16)}8${hex.slice(17, 32)}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(
    16,
    20,
  )}-${value.slice(20)}`;
}

/** Firestore twin of the PostgreSQL `device_tokens` upsert on the unique token. */
export class FirestoreDeviceTokenRepository implements DeviceTokenRepository {
  readonly kind = 'device-token-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async register(agentId: string, registration: DeviceTokenRegistrationInput): Promise<void> {
    if (!agentId) throw new Error('agent is required');
    if (!registration.token) throw new Error('device token is required');
    await this.store.db.runTransaction(async (tx) => {
      const agents = await tx.get(this.store.collection('agents').limit(2));
      const owner = agents.docs[0];
      if (
        agents.size !== 1 ||
        !owner ||
        owner.id !== documentKey(agentId) ||
        owner.get('id') !== agentId
      )
        throw new Error('Device registration requires one matching configured agent');
      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId || privacyErasureIsActive(erasure.get('status')))
      )
        throw new Error('Privacy erasure is in progress');

      const existing = await tx.get(
        this.store.collection('deviceTokens').where('token', '==', registration.token).limit(2),
      );
      if (existing.size > 1) throw new Error('Device token has duplicate rows');
      const now = this.store.now();
      const current = existing.docs[0];
      if (current) {
        const id = current.get('id');
        if (typeof id !== 'string' || documentKey(id) !== current.id)
          throw new Error('Device token row is malformed');
        tx.update(
          current.ref,
          encodeRecord({
            agentId,
            environment: registration.environment,
            lastSeenAt: now,
            invalidatedAt: null,
          }),
        );
        return;
      }
      const id = deviceTokenId(registration.token);
      tx.create(
        this.store.doc('deviceTokens', id),
        encodeRecord({
          id,
          createdAt: now,
          agentId,
          lastSeenAt: now,
          token: registration.token,
          platform: registration.platform,
          environment: registration.environment,
          invalidatedAt: null,
        }),
      );
    });
  }
}
