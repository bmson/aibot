import type { VoiceSamplePurgeRepository } from '@assistant/persistence';
import type { Query } from '@google-cloud/firestore';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { documentKey, type InstallationStore } from './store.js';

/** Must match core's VOICE_IMPORT_SOURCE_PREFIX and the purgeable sample contexts. */
const VOICE_SOURCE_PREFIX = 'voice-samples';
const PURGEABLE_CONTEXTS = ['auto:', 'upload:'];
const ACTIVE_TASK_STATUSES = ['pending', 'sleeping', 'running', 'needs_attention'];
/** Deletes per transaction, under Firestore's 500-write commit limit. */
const PAGE = 400;
const SOURCE_LIMIT = 500;

/** Documents whose string `field` starts with `prefix`, as a range query. */
function withPrefix(query: Query, field: string, prefix: string): Query {
  return query.where(field, '>=', prefix).where(field, '<', `${prefix}`);
}

/**
 * The voice purge on Firestore. PostgreSQL does it in one transaction; here the
 * voice imports are stopped first, so no new sample can land, and the samples
 * are then deleted in bounded pages, each fenced against a privacy erasure.
 */
export class FirestoreVoiceSamplePurgeRepository implements VoiceSamplePurgeRepository {
  readonly kind = 'voice-sample-purge-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {}

  async purge(): Promise<{ deleted: number; workspacePaths: string[] }> {
    const agentId = this.agentId;
    const sources = await withPrefix(
      this.store.collection('importSources').where('agentId', '==', agentId),
      'source',
      VOICE_SOURCE_PREFIX,
    )
      .limit(SOURCE_LIMIT + 1)
      .get();
    if (sources.size > SOURCE_LIMIT) throw new Error('Voice import sources exceed the purge bound');

    // Stop every voice import before touching samples, so none lands afterwards.
    await this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      const taskIds = [
        ...new Set(
          sources.docs.map((doc) => doc.get('taskId')).filter((id) => typeof id === 'string'),
        ),
      ] as string[];
      const tasks = taskIds.length
        ? await tx.getAll(...taskIds.map((id) => this.store.doc('tasks', id)))
        : [];
      const now = this.store.now();
      for (const task of tasks) {
        if (!task.exists || task.get('agentId') !== agentId) continue;
        if (ACTIVE_TASK_STATUSES.includes(String(task.get('status'))))
          tx.update(task.ref, {
            status: 'cancelled',
            lockedUntil: null,
            runAfter: null,
            leaseToken: null,
            updatedAt: now,
          });
      }
    });

    let deleted = 0;
    for (const context of PURGEABLE_CONTEXTS) {
      for (;;) {
        const page = withPrefix(
          this.store.collection('writingSamples').where('agentId', '==', agentId),
          'context',
          context,
        ).limit(PAGE);
        const removed = await this.store.db.runTransaction(async (tx) => {
          await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
          const rows = await tx.get(page);
          for (const doc of rows.docs) tx.delete(doc.ref);
          return rows.size;
        });
        deleted += removed;
        if (removed < PAGE) break;
      }
    }

    await this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      for (const doc of sources.docs)
        if (doc.get('agentId') === agentId && documentKey(String(doc.get('id'))) === doc.id)
          tx.delete(doc.ref);
    });
    return {
      deleted,
      workspacePaths: sources.docs
        .map((doc) => doc.get('workspacePath'))
        .filter((path): path is string => typeof path === 'string' && path.length > 0),
    };
  }
}
