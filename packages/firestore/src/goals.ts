import type { GoalReadRepository, Records } from '@assistant/persistence';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

async function assertConfiguredOwner(store: InstallationStore, agentId: string) {
  const agents = await store.collection('agents').limit(2).get();
  const owner = agents.docs[0];
  if (
    !agentId ||
    agents.size !== 1 ||
    !owner ||
    owner.id !== documentKey(agentId) ||
    owner.get('id') !== agentId
  )
    throw new Error('Goals require exactly one configured agent');
}

/** SQL-free, installation-owner-scoped reads for mobile Goals. */
export class FirestoreGoalReadRepository implements GoalReadRepository {
  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async list(agentId: string) {
    if (agentId !== this.configuredAgentId)
      throw new Error('Goal read is outside the configured installation');
    await assertConfiguredOwner(this.store, agentId);
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const [goals, conversations, tasks, schedules] = await Promise.all([
      this.store.collection('goals').where('agentId', '==', agentId).get(),
      this.store
        .collection('conversations')
        .where('agentId', '==', agentId)
        .where('channel', '==', 'chat')
        .get(),
      this.store.collection('tasks').where('agentId', '==', agentId).get(),
      this.store.collection('schedules').where('agentId', '==', agentId).get(),
    ]);
    const owned = <T extends { id: string; agentId: string }>(
      docs: FirebaseFirestore.QuerySnapshot,
    ) =>
      docs.docs.flatMap((doc) => {
        const row = decodeRecord<T>(doc.data());
        return row.agentId === agentId && documentKey(row.id) === doc.id ? [row] : [];
      });
    const result = {
      goals: owned<Records['goals']>(goals),
      conversations: owned<Records['conversations']>(conversations),
      tasks: owned<Records['tasks']>(tasks),
      schedules: owned<Records['schedules']>(schedules),
    };
    await assertConfiguredOwner(this.store, agentId);
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return result;
  }

  async get(agentId: string, id: string): Promise<Records['goals'] | null> {
    if (agentId !== this.configuredAgentId)
      throw new Error('Goal read is outside the configured installation');
    await assertConfiguredOwner(this.store, agentId);
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const doc = await this.store.doc('goals', id).get();
    const row = doc.exists ? decodeRecord<Records['goals']>(doc.data()) : null;
    await assertConfiguredOwner(this.store, agentId);
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return row && documentKey(row.id) === doc.id && row.agentId === agentId ? row : null;
  }
}
