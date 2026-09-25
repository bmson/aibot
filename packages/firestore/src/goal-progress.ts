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
    const goal = await this.write(input.agentId, input.goalId, {
      progress: input.progress,
      nextAction: input.nextAction,
    });
    if (!goal) throw new Error('goal not found');
    return { updated: goal.id, title: goal.title };
  }

  /**
   * Park the goal on an owner question. Like the PostgreSQL update it
   * replaces, a goal that no longer exists is left alone.
   */
  async recordBlocked(input: { agentId: string; goalId: string; nextAction: string }) {
    if (!this.configuredAgentId || input.agentId !== this.configuredAgentId)
      throw new Error('Goal progress is outside the configured owner');
    if (!input.nextAction || input.nextAction.length > 500)
      throw new Error('Invalid goal next action');
    await this.write(input.agentId, input.goalId, { nextAction: input.nextAction });
  }

  private write(
    agentId: string,
    goalId: string,
    patch: Partial<Pick<Records['goals'], 'progress' | 'nextAction'>>,
  ): Promise<Records['goals'] | null> {
    return this.store.db.runTransaction(async (tx) => {
      const owners = await tx.get(this.store.collection('agents').limit(2));
      const owner = owners.docs[0];
      if (
        owners.size !== 1 ||
        !owner ||
        owner.id !== documentKey(agentId) ||
        owner.get('id') !== agentId
      )
        throw new Error('Goals require exactly one configured owner');

      const goalRef = this.store.doc('goals', goalId);
      const [goalDoc, erasure] = await tx.getAll(
        goalRef,
        this.store.doc('privacyErasureJobs', agentId),
      );
      if (
        erasure?.exists &&
        (erasure.get('agentId') !== agentId || privacyErasureIsActive(erasure.get('status')))
      )
        throw new Error('Privacy erasure is in progress');
      if (!goalDoc?.exists) return null;
      const goal = decodeRecord<Records['goals']>(goalDoc.data());
      if (goal.id !== goalId || documentKey(goal.id) !== goalDoc.id || goal.agentId !== agentId)
        return null;
      tx.update(goalRef, { ...patch, updatedAt: this.store.now() });
      return goal;
    });
  }
}
