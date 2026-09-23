import type { TaskActivityCommandRepository } from '@assistant/persistence';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

/** Archives or restores one owned task in the same transaction as its safety checks. */
export class FirestoreTaskActivityCommandRepository implements TaskActivityCommandRepository {
  readonly kind = 'task-activity-command-repository' as const;

  constructor(readonly store: InstallationStore) {}

  archive(agentId: string, taskId: string): Promise<void> {
    return this.change(agentId, taskId, 'archive');
  }

  restore(agentId: string, taskId: string): Promise<void> {
    return this.change(agentId, taskId, 'restore');
  }

  private async change(
    agentId: string,
    taskId: string,
    action: 'archive' | 'restore',
  ): Promise<void> {
    if (!agentId || !taskId) throw new Error('Activity agent and task are required');
    await this.store.db.runTransaction(async (tx) => {
      const agents = await tx.get(this.store.collection('agents').limit(2));
      const agent = agents.docs[0];
      if (
        agents.size !== 1 ||
        !agent ||
        agent.id !== documentKey(agentId) ||
        agent.get('id') !== agentId
      )
        throw new Error('Activity requires one matching configured agent');

      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime)
      )
        throw new Error('Privacy erasure is in progress');

      const ref = this.store.doc('tasks', taskId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) throw new Error('activity item not found');
      const task = decodeRecord<Record<string, unknown>>(snapshot.data());
      if (task.agentId !== agentId) throw new Error('activity item not found');
      if (
        task.id !== taskId ||
        documentKey(taskId) !== snapshot.id ||
        typeof task.status !== 'string' ||
        !(
          task.archivedAt === null ||
          (task.archivedAt instanceof Date && Number.isFinite(task.archivedAt.getTime()))
        )
      )
        throw new Error('Invalid activity task');

      if (action === 'archive') {
        if (!TERMINAL.has(task.status))
          throw new Error('only completed, failed, or cancelled activity can be archived');
        // PostgreSQL leaves an already-archived task unchanged.
        if (task.archivedAt !== null) return;
      }
      const now = this.store.now();
      tx.update(ref, { archivedAt: action === 'archive' ? now : null, updatedAt: now });
    });
  }
}
