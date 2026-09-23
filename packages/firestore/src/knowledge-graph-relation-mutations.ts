import type { Records } from '@assistant/persistence';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { documentKey, type InstallationStore } from './store.js';

/** Owner review of one source-backed relationship; rejection retains its evidence. */
export class FirestoreKnowledgeGraphRelationMutationRepository {
  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async review(id: string, status: 'confirmed' | 'rejected'): Promise<boolean> {
    if (!id || !this.configuredAgentId) return false;
    const ref = this.store.doc('knowledgeGraphRelations', id);
    return this.store.db.runTransaction(async (tx) => {
      const owners = await tx.get(this.store.collection('agents').limit(2));
      if (
        owners.size !== 1 ||
        owners.docs[0]?.id !== documentKey(this.configuredAgentId) ||
        owners.docs[0]?.get('id') !== this.configuredAgentId
      )
        throw new Error('Knowledge relation review requires one configured owner');
      const [erasure, snapshot] = await tx.getAll(
        this.store.doc('privacyErasureJobs', this.configuredAgentId),
        ref,
      );
      if (
        erasure?.exists &&
        (erasure.get('agentId') !== this.configuredAgentId ||
          privacyErasureIsActive(erasure.get('status')))
      )
        throw new Error('Privacy erasure is in progress');
      if (!snapshot?.exists) return false;
      const relation = snapshot.data() as Records['knowledgeGraphRelations'] | undefined;
      if (
        relation?.id !== id ||
        relation.agentId !== this.configuredAgentId ||
        documentKey(relation.id) !== snapshot.id
      )
        return false;
      tx.update(ref, { reviewStatus: status, reviewedAt: this.store.now() });
      return true;
    });
  }
}
