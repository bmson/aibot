import type { ShellStatusProjection, ShellStatusRepository } from '@assistant/persistence';
import { FieldPath, type Query } from '@google-cloud/firestore';
import { loadProfileHubSource, profileMemoryHubFromSource } from './profile-memory-hub.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const APPROVAL_PAGE_SIZE = 500;
const MAX_PENDING_APPROVAL_SCAN = 100_000;

async function countPendingApprovals(
  store: InstallationStore,
  ownerTaskIds: Set<string>,
  now: Date,
): Promise<number> {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  let scanned = 0;
  let pending = 0;
  const base = store.collection('approvals').where('status', '==', 'pending') as Query;
  while (true) {
    let query = base.orderBy(FieldPath.documentId()).limit(APPROVAL_PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    scanned += snapshot.size;
    if (scanned > MAX_PENDING_APPROVAL_SCAN)
      throw new Error('Shell status approval scan exceeds its explicit limit');
    for (const doc of snapshot.docs) {
      const approval = decodeRecord<{
        id: string;
        taskId: string;
        status: string;
        expiresAt: Date;
      }>(doc.data());
      if (!approval.id || documentKey(approval.id) !== doc.id)
        throw new Error('Malformed shell status approval record');
      if (!(approval.expiresAt instanceof Date) || !Number.isFinite(approval.expiresAt.getTime()))
        throw new Error('Malformed shell status approval expiry');
      if (!approval.taskId) throw new Error('Malformed shell status approval task reference');
      if (approval.expiresAt > now && ownerTaskIds.has(approval.taskId)) pending += 1;
    }
    if (snapshot.size < APPROVAL_PAGE_SIZE) break;
    cursor = snapshot.docs.at(-1);
  }

  return pending;
}

/** Exact, bounded owner-facing shell counts backed only by installation Firestore data. */
export class FirestoreShellStatusRepository implements ShellStatusRepository {
  readonly kind = 'shell-status-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId?: string,
  ) {}

  async load(agentId: string): Promise<ShellStatusProjection> {
    if (this.configuredAgentId && this.configuredAgentId !== agentId)
      throw new Error('Shell status agent is outside the configured installation');
    const source = await loadProfileHubSource(this.store, this.configuredAgentId);
    if (source.agentId !== agentId)
      throw new Error('Shell status agent is outside the configured installation');

    const ownerTasks = source.tasks;
    const ownerTaskIds = new Set(ownerTasks.map((task) => task.id));
    const [pendingApprovals, memoryHealth] = await Promise.all([
      countPendingApprovals(this.store, ownerTaskIds, source.now),
      Promise.resolve(profileMemoryHubFromSource(source).memoryHealth),
    ]);
    const needsAttention = ownerTasks.filter((task) => task.status === 'needs_attention').length;
    const running = ownerTasks.filter((task) => task.status === 'running').length;

    return {
      dashboard: {
        pendingApprovals,
        needsAttention,
        presence:
          pendingApprovals > 0 || needsAttention > 0
            ? 'attention'
            : running > 0
              ? 'working'
              : 'idle',
      },
      memoryHealth,
    };
  }
}
