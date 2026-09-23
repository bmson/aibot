import type { SkillMutationRepository } from '@assistant/persistence';
import { validateSkillEmbedding } from '@assistant/persistence';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { skillFromDocument } from './skill-library.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

/** Updates or hard-deletes one existing skill under its owner's erasure fence. */
export class FirestoreSkillMutationRepository implements SkillMutationRepository {
  readonly kind = 'skill-mutation-repository' as const;

  constructor(readonly store: InstallationStore) {}

  setDeprecated(agentId: string, skillId: string, deprecated: boolean): Promise<void> {
    if (typeof deprecated !== 'boolean') throw new Error('deprecated must be a boolean');
    return this.change(agentId, skillId, deprecated);
  }

  delete(agentId: string, skillId: string): Promise<void> {
    return this.change(agentId, skillId, null);
  }

  private async change(
    agentId: string,
    skillId: string,
    deprecated: boolean | null,
  ): Promise<void> {
    if (!agentId || !skillId) throw new Error('Skill owner and ID are required');
    await this.store.db.runTransaction(async (tx) => {
      const agents = await tx.get(this.store.collection('agents').limit(2));
      const agent = agents.docs[0];
      if (
        agents.size !== 1 ||
        !agent ||
        agent.id !== documentKey(agentId) ||
        agent.get('id') !== agentId
      )
        throw new Error('Skill mutation requires one matching configured owner');

      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime)
      )
        throw new Error('Privacy erasure is in progress');

      const ref = this.store.doc('skills', skillId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('agentId') !== agentId)
        throw new Error('Skill not found');
      skillFromDocument(snapshot.data(), snapshot.id, agentId);
      const row = decodeRecord<Record<string, unknown>>(snapshot.data());
      if (
        !(row.createdAt instanceof Date) ||
        !Number.isFinite(row.createdAt.getTime()) ||
        (row.originTrust !== 'owner' && row.originTrust !== 'assistant') ||
        !(row.sourceTaskId === null || typeof row.sourceTaskId === 'string') ||
        !(
          row.lastVerifiedAt === null ||
          (row.lastVerifiedAt instanceof Date && Number.isFinite(row.lastVerifiedAt.getTime()))
        ) ||
        !(row.embedding === null || Array.isArray(row.embedding))
      )
        throw new Error('Invalid learned-skill document');
      if (Array.isArray(row.embedding)) validateSkillEmbedding(row.embedding as number[]);

      if (deprecated === null) tx.delete(ref);
      else tx.update(ref, { deprecated, updatedAt: this.store.now() });
    });
  }
}
