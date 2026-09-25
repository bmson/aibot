import type { ActiveJobLookup, ActiveJobTask } from '@assistant/persistence';
import { documentKey, type InstallationStore } from './store.js';

/**
 * Uses the existing `(agentId, trigger.payload.job, status)` task index. Any
 * unfinished match makes a trigger a no-op, so no ordering is needed.
 */
export class FirestoreActiveJobLookup implements ActiveJobLookup {
  readonly kind = 'active-job-lookup' as const;

  constructor(readonly store: InstallationStore) {}

  async findActive(agentId: string, job: string): Promise<ActiveJobTask | null> {
    if (!agentId || !job) throw new Error('agent and job are required');
    const snapshot = await this.store
      .collection('tasks')
      .where('agentId', '==', agentId)
      .where('trigger.payload.job', '==', job)
      .where('status', 'in', ['pending', 'running'])
      .limit(1)
      .get();
    const doc = snapshot.docs[0];
    if (!doc) return null;
    const id = doc.get('id');
    const status = doc.get('status');
    if (typeof id !== 'string' || documentKey(id) !== doc.id)
      throw new Error('Active job task is malformed');
    return { id, status: status === 'running' ? 'running' : 'pending' };
  }
}
