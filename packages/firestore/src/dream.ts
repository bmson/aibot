import { createHash } from 'node:crypto';
import type { DreamRepository, NewDreamNote, Records } from '@assistant/persistence';
import type { QueryDocumentSnapshot } from '@google-cloud/firestore';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

/** A stable UUID per dream task and note, so a retried run rewrites the same notes. */
function noteIdFor(taskId: string, index: number, note: NewDreamNote): string {
  const hex = createHash('sha256')
    .update(JSON.stringify([taskId, index, note.kind, note.content]))
    .digest('hex');
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The overnight dream's reads and notes on Firestore. Tool calls and approvals
 * carry no owner, so they are kept only when their task is the owner's.
 */
export class FirestoreDreamRepository implements DreamRepository {
  readonly kind = 'dream-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {}

  private owned(agentId: string): void {
    if (agentId !== this.agentId) throw new Error('Dream is outside the configured owner');
  }

  /** The subset of `docs` whose `taskId` names one of the owner's tasks. */
  private async ownedByTask(docs: QueryDocumentSnapshot[]): Promise<QueryDocumentSnapshot[]> {
    const taskIds = [
      ...new Set(docs.map((doc) => doc.get('taskId')).filter((id) => typeof id === 'string')),
    ];
    if (taskIds.length === 0) return [];
    const tasks = await this.store.db.getAll(...taskIds.map((id) => this.store.doc('tasks', id)));
    const owned = new Set(
      tasks.flatMap((task) =>
        task.exists && task.get('agentId') === this.agentId ? [task.get('id')] : [],
      ),
    );
    return docs.filter((doc) => owned.has(doc.get('taskId')));
  }

  async failedTasks(
    agentId: string,
    since: Date,
    limit: number,
  ): Promise<Array<{ type: string; progress: string; status: string }>> {
    this.owned(agentId);
    const snapshot = await this.store
      .collection('tasks')
      .where('agentId', '==', agentId)
      .where('status', 'in', ['needs_attention', 'failed'])
      .where('updatedAt', '>=', since)
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => ({
      type: String(doc.get('type')),
      progress: typeof doc.get('progress') === 'string' ? doc.get('progress') : '',
      status: String(doc.get('status')),
    }));
  }

  async failedToolCalls(
    agentId: string,
    since: Date,
    limit: number,
  ): Promise<Array<{ toolName: string; error: string | null }>> {
    this.owned(agentId);
    const snapshot = await this.store
      .collection('toolCalls')
      .where('status', '==', 'failed')
      .where('createdAt', '>=', since)
      .limit(limit)
      .get();
    return (await this.ownedByTask(snapshot.docs)).map((doc) => ({
      toolName: String(doc.get('toolName')),
      error: typeof doc.get('error') === 'string' ? doc.get('error') : null,
    }));
  }

  async approvalDecisions(
    agentId: string,
    since: Date,
    limit: number,
  ): Promise<Array<{ summary: string; status: string }>> {
    this.owned(agentId);
    const snapshot = await this.store
      .collection('approvals')
      .where('status', 'in', ['approved', 'denied'])
      .where('requestedAt', '>=', since)
      .orderBy('requestedAt', 'desc')
      .limit(limit)
      .get();
    return (await this.ownedByTask(snapshot.docs)).map((doc) => {
      const row = decodeRecord<Records['approvals']>(doc.data());
      return { summary: row.summary, status: row.status };
    });
  }

  async addNotes(agentId: string, taskId: string, notes: NewDreamNote[]): Promise<void> {
    this.owned(agentId);
    if (notes.length === 0) return;
    await this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      const now = this.store.now();
      notes.forEach((note, index) => {
        const id = noteIdFor(taskId, index, note);
        const row: Records['dreamNotes'] = {
          id,
          agentId,
          kind: note.kind,
          content: note.content,
          expiresAt: note.expiresAt,
          refIds: [],
          createdAt: now,
        };
        tx.set(this.store.doc('dreamNotes', id), encodeRecord(row));
      });
    });
  }
}
