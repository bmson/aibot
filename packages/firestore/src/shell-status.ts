import type { Records, ShellStatusProjection, ShellStatusRepository } from '@assistant/persistence';
import { FieldPath, type Query, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const PAGE_SIZE = 500;
const MAX_TASK_SCAN = 100_000;
const MAX_MEMORY_SCAN = 100_000;
const APPROVAL_PAGE_SIZE = 500;
const MAX_PENDING_APPROVAL_SCAN = 100_000;

async function scanPages(
  query: Query,
  collection: 'tasks' | 'memories',
  visit: (doc: QueryDocumentSnapshot) => void,
): Promise<void> {
  const max = collection === 'tasks' ? MAX_TASK_SCAN : MAX_MEMORY_SCAN;
  let cursor: QueryDocumentSnapshot | undefined;
  let scanned = 0;
  while (true) {
    let page = query.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    scanned += snapshot.size;
    if (scanned > max)
      throw new Error(`Shell status ${collection} scan exceeds its explicit limit`);
    for (const doc of snapshot.docs) visit(doc);
    if (snapshot.size < PAGE_SIZE) return;
    cursor = snapshot.docs.at(-1);
  }
}

async function countPendingApprovals(
  store: InstallationStore,
  ownerTaskIds: Set<string>,
  now: Date,
): Promise<number> {
  let cursor: QueryDocumentSnapshot | undefined;
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

async function resolveShellAgent(
  store: InstallationStore,
  pinnedAgentId?: string,
): Promise<string> {
  const configured = pinnedAgentId ? null : await store.collection('agents').limit(2).get();
  if (configured && (configured.size !== 1 || !configured.docs[0]))
    throw new Error('Memory hub requires exactly one configured agent');
  const agentDoc = pinnedAgentId
    ? await store.doc('agents', pinnedAgentId).get()
    : configured?.docs[0];
  if (!agentDoc?.exists) throw new Error('Configured Memory hub agent is missing');
  const agentId = agentDoc.get('id');
  if (
    typeof agentId !== 'string' ||
    documentKey(agentId) !== agentDoc.id ||
    (pinnedAgentId !== undefined && agentId !== pinnedAgentId)
  )
    throw new Error('Configured agent record is malformed');
  return agentId;
}

/** Exact owner-facing shell counts, scanned a page at a time without retaining record bodies. */
export class FirestoreShellStatusRepository implements ShellStatusRepository {
  readonly kind = 'shell-status-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId?: string,
  ) {}

  async load(agentId: string): Promise<ShellStatusProjection> {
    if (this.configuredAgentId && this.configuredAgentId !== agentId)
      throw new Error('Shell status agent is outside the configured installation');
    const ownerAgentId = await resolveShellAgent(this.store, this.configuredAgentId);
    if (ownerAgentId !== agentId)
      throw new Error('Shell status agent is outside the configured installation');

    const fence = await readPrivacyErasureFence(this.store, ownerAgentId);
    const now = this.store.now();
    const ownerTaskIds = new Set<string>();
    let needsAttention = 0;
    let running = 0;
    let totalUsable = 0;
    let notYetOrganized = 0;
    let awaitingReview = 0;
    let ownerConfirmed = 0;
    let lastOrganizedAt: Date | null = null;

    await scanPages(
      this.store.collection('tasks').where('agentId', '==', ownerAgentId) as Query,
      'tasks',
      (doc) => {
        const task = decodeRecord<Records['tasks']>(doc.data());
        if (!task.id || documentKey(task.id) !== doc.id || task.agentId !== ownerAgentId)
          throw new Error('Malformed or foreign shell status task');
        ownerTaskIds.add(task.id);
        if (task.status === 'needs_attention') needsAttention += 1;
        if (task.status === 'running') running += 1;
      },
    );
    await scanPages(
      this.store.collection('memories').where('agentId', '==', ownerAgentId) as Query,
      'memories',
      (doc) => {
        const memory = decodeRecord<Records['memories']>(doc.data());
        if (!memory.id || documentKey(memory.id) !== doc.id || memory.agentId !== ownerAgentId)
          throw new Error('Malformed or foreign shell status memory');
        const unexpired = !memory.expiresAt || memory.expiresAt > now;
        if (memory.category !== 'knowledge' || !unexpired) return;
        if (memory.quarantined) {
          awaitingReview += 1;
          return;
        }
        totalUsable += 1;
        if (memory.ownerConfirmed) ownerConfirmed += 1;
        if (!memory.lastConsolidatedAt) {
          notYetOrganized += 1;
        } else if (memory.lastConsolidatedAt instanceof Date) {
          if (!lastOrganizedAt || memory.lastConsolidatedAt > lastOrganizedAt)
            lastOrganizedAt = memory.lastConsolidatedAt;
        }
      },
    );
    await assertPrivacyErasureFenceUnchanged(this.store, ownerAgentId, fence);

    const pendingApprovals = await countPendingApprovals(this.store, ownerTaskIds, now);
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
      memoryHealth: {
        totalUsable,
        notYetOrganized,
        awaitingReview,
        ownerConfirmed,
        lastOrganizedAt,
      },
    };
  }
}
