import type { ShellPresence, ShellPresenceRepository } from '@assistant/persistence';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const MAX_ACTIVE_APPROVALS = 100;
const APPROVAL_TASK_READ_BATCH = 100;

/**
 * Cheap presence read for the live shell poll. Task probes read at most one
 * owner row per state; approval probes read at most 100 active approvals and
 * fail explicitly if an exact negative result cannot be established.
 */
export class FirestoreShellPresenceRepository implements ShellPresenceRepository {
  readonly kind = 'shell-presence-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async load(agentId: string): Promise<ShellPresence> {
    if (agentId !== this.configuredAgentId)
      throw new Error('Shell presence agent is outside the configured installation');

    const attentionTask = await this.store
      .collection('tasks')
      .where('agentId', '==', agentId)
      .where('status', '==', 'needs_attention')
      .limit(1)
      .get();
    const attention = attentionTask.docs[0];
    if (attention) {
      const task = decodeRecord<{ id: string; agentId: string }>(attention.data());
      if (task.agentId !== agentId || !task.id || documentKey(task.id) !== attention.id)
        throw new Error('Malformed shell presence task record');
      return 'attention';
    }

    const now = this.store.now();
    const approvals = await this.store
      .collection('approvals')
      .where('status', '==', 'pending')
      .where('expiresAt', '>', now)
      .limit(MAX_ACTIVE_APPROVALS + 1)
      .get();
    const approvalDocs = approvals.docs.slice(0, MAX_ACTIVE_APPROVALS);
    const taskIds = new Set<string>();
    for (const doc of approvalDocs) {
      const approval = decodeRecord<{ id: string; taskId: string; expiresAt: Date }>(doc.data());
      if (!approval.id || documentKey(approval.id) !== doc.id || !approval.taskId)
        throw new Error('Malformed shell presence approval record');
      if (!(approval.expiresAt instanceof Date) || approval.expiresAt <= now)
        throw new Error('Malformed shell presence approval expiry');
      taskIds.add(approval.taskId);
    }

    const taskIdRows = [...taskIds];
    for (let offset = 0; offset < taskIdRows.length; offset += APPROVAL_TASK_READ_BATCH) {
      const refs = taskIdRows
        .slice(offset, offset + APPROVAL_TASK_READ_BATCH)
        .map((taskId) => this.store.doc('tasks', taskId));
      const taskSnapshots = await this.store.db.getAll(...refs);
      for (const taskSnapshot of taskSnapshots) {
        if (!taskSnapshot.exists) continue;
        const task = decodeRecord<{ id: string; agentId: string }>(taskSnapshot.data());
        if (task.agentId !== agentId) continue;
        if (!task.id || documentKey(task.id) !== taskSnapshot.id)
          throw new Error('Malformed shell presence task record');
        return 'attention';
      }
    }

    if (approvals.size > MAX_ACTIVE_APPROVALS)
      throw new Error('Shell presence approval probe exceeds its explicit limit');

    const runningTask = await this.store
      .collection('tasks')
      .where('agentId', '==', agentId)
      .where('status', '==', 'running')
      .limit(1)
      .get();
    const running = runningTask.docs[0];
    if (!running) return 'idle';
    const task = decodeRecord<{ id: string; agentId: string }>(running.data());
    if (task.agentId !== agentId || !task.id || documentKey(task.id) !== running.id)
      throw new Error('Malformed shell presence task record');
    return 'working';
  }
}
