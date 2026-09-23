import { normalizeVoiceProfileEdit, type VoiceProfileEditInput } from '@assistant/persistence';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { documentKey, type InstallationStore } from './store.js';

/** Owner-scoped edit of the one distilled voice profile in an installation. */
export class FirestoreVoiceProfileRepository {
  constructor(private readonly store: InstallationStore) {}

  async update(agentId: string, input: VoiceProfileEditInput): Promise<{ error?: string }> {
    const normalized = normalizeVoiceProfileEdit(input);
    if (!normalized.value) return { error: normalized.error };
    if (!agentId) throw new Error('Voice profile requires a configured owner');
    await this.store.db.runTransaction(async (tx) => {
      const owners = await tx.get(this.store.collection('agents').limit(2));
      const owner = owners.docs[0];
      if (
        owners.size !== 1 ||
        !owner ||
        owner.id !== documentKey(agentId) ||
        owner.get('id') !== agentId
      )
        throw new Error('Voice profile requires one matching configured owner');

      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId || privacyErasureIsActive(erasure.get('status')))
      )
        throw new Error('Privacy erasure is in progress');

      const profileRef = this.store.doc('voiceProfile', '1');
      const existing = await tx.get(profileRef);
      if (existing.exists && existing.get('id') !== 1)
        throw new Error('Voice profile record is malformed');
      tx.set(profileRef, { id: 1, ...normalized.value, updatedAt: this.store.now() });
    });
    return {};
  }
}
