import type { GoalProgressRepository, Records } from '@assistant/persistence';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

/** Owner-scoped progress write; leaves goal status and automation untouched. */
export class FirestoreGoalProgressRepository implements GoalProgressRepository {
  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async updateProgress(input: {
    agentId: string;
    goalId: string;
    progress: string;
    nextAction: string;
  }): Promise<{ updated: string; title: string }> {
    if (!this.configuredAgentId || input.agentId !== this.configuredAgentId)
      throw new Error('Goal progress is outside the configured owner');
    if (!input.progress || input.progress.length > 1000 || input.nextAction.length > 500)
      throw new Error('Invalid goal progress');
    return this.store.db.runTransaction(async (tx) => {
      const owners = await tx.get(this.store.collection('agents').limit(2));
      const owner = owners.docs[0];
      if (
        owners.size !== 1 ||
        !owner ||
        owner.id !== documentKey(input.agentId) ||
        owner.get('id') !== input.agentId
      )
        throw new Error('Goals require exactly one configured owner');

      const goalRef = this.store.doc('goals', input.goalId);
      const [goalDoc, erasure] = await tx.getAll(
        goalRef,
        this.store.doc('privacyErasureJobs', input.agentId),
      );
      if (
        erasure?.exists &&
        (erasure.get('agentId') !== input.agentId || privacyErasureIsActive(erasure.get('status')))
      )
        throw new Error('Privacy erasure is in progress');
      if (!goalDoc?.exists) throw new Error('goal not found');
      const goal = decodeRecord<Records['goals']>(goalDoc.data());
      if (
        goal.id !== input.goalId ||
        documentKey(goal.id) !== goalDoc.id ||
        goal.agentId !== input.agentId
      )
        throw new Error('goal not found');
      tx.update(goalRef, {
        progress: input.progress,
        nextAction: input.nextAction,
        updatedAt: this.store.now(),
      });
      return { updated: goal.id, title: goal.title };
    });
  }
}
