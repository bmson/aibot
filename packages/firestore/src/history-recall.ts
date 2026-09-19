import {
  type EmbeddingSpace,
  type HistoryMessage,
  type HistoryRecallRepository,
  type HistorySearch,
  type HistorySegment,
  historyLimit,
  type Records,
  validateEmbedding,
  validateSkillEmbeddingSpace,
} from '@assistant/persistence';
import type { DocumentSnapshot, QueryDocumentSnapshot } from '@google-cloud/firestore';
import { embeddingSpaceKey } from './memory.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

function trusted(snapshot: DocumentSnapshot, agentId: string): boolean {
  return (
    snapshot.exists &&
    snapshot.get('agentId') === agentId &&
    ['owner', 'assistant'].includes(snapshot.get('trust')) &&
    typeof snapshot.get('id') === 'string' &&
    documentKey(snapshot.get('id')) === snapshot.id
  );
}

function message(snapshot: DocumentSnapshot): HistoryMessage | null {
  if (!snapshot.exists) return null;
  const row = decodeRecord<Records['messages']>(snapshot.data());
  if (
    typeof row.id !== 'string' ||
    documentKey(row.id) !== snapshot.id ||
    typeof row.conversationId !== 'string' ||
    !['user', 'assistant'].includes(row.role) ||
    typeof row.text !== 'string' ||
    !(row.createdAt instanceof Date)
  )
    return null;
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    text: row.text,
    createdAt: row.createdAt,
  };
}

/** Native vector retrieval with a consistent owner/trust recheck before prompt exposure. */
export class FirestoreHistoryRecallRepository implements HistoryRecallRepository {
  readonly kind = 'history-recall-repository' as const;
  constructor(
    readonly store: InstallationStore,
    readonly space: EmbeddingSpace,
  ) {
    validateSkillEmbeddingSpace(space);
  }

  private async candidates(collection: 'messages' | 'conversationSegments', input: HistorySearch) {
    historyLimit(input.limit);
    validateEmbedding(this.space, input.embedding);
    const candidateLimit = Math.min(200, input.limit * 4);
    let query = this.store
      .collection(collection)
      .where('embeddingSpace', '==', embeddingSpaceKey(this.space));
    if (collection === 'conversationSegments') query = query.where('agentId', '==', input.agentId);
    const result = await query
      .findNearest({
        vectorField: 'embedding',
        queryVector: input.embedding,
        distanceMeasure: 'COSINE',
        limit: candidateLimit,
        distanceResultField: 'vectorDistance',
      })
      .get();
    return { docs: result.docs, full: result.size === candidateLimit };
  }

  private unchanged(snapshot: DocumentSnapshot, candidate: QueryDocumentSnapshot): boolean {
    return Boolean(
      snapshot.exists &&
        snapshot.updateTime &&
        candidate.updateTime &&
        snapshot.updateTime.isEqual(candidate.updateTime) &&
        snapshot.get('embeddingSpace') === embeddingSpaceKey(this.space),
    );
  }

  async segments(input: HistorySearch): Promise<HistorySegment[]> {
    const candidates = await this.candidates('conversationSegments', input);
    if (candidates.docs.length === 0) return [];
    return this.store.db.runTransaction(
      async (tx) => {
        const snapshots = await tx.getAll(...candidates.docs.map((doc) => doc.ref));
        const valid = snapshots.flatMap((snapshot, i) => {
          const candidate = candidates.docs[i];
          if (!candidate || !this.unchanged(snapshot, candidate)) return [];
          const row = decodeRecord<Records['conversationSegments']>(snapshot.data());
          const similarity = 1 - Number(candidate.get('vectorDistance'));
          if (
            typeof row.id !== 'string' ||
            documentKey(row.id) !== snapshot.id ||
            row.agentId !== input.agentId ||
            typeof row.conversationId !== 'string' ||
            typeof row.startMessageId !== 'string' ||
            !row.summary ||
            !(row.startedAt instanceof Date) ||
            !(row.endedAt instanceof Date) ||
            !Number.isFinite(similarity) ||
            (row.conversationId === input.exclude.conversationId &&
              row.endedAt >= input.exclude.sinceCreatedAt)
          )
            return [];
          return [{ row, similarity }];
        });
        if (valid.length === 0) {
          if (candidates.full) throw new Error('History segment candidate bound reached');
          return [];
        }
        const sources = await tx.getAll(
          ...valid.flatMap(({ row }) => [
            this.store.doc('conversations', row.conversationId),
            this.store.doc('messages', row.startMessageId),
          ]),
        );
        const result = valid.flatMap(({ row, similarity }, i) => {
          const conversation = sources[i * 2],
            key = sources[i * 2 + 1];
          if (!conversation || !trusted(conversation, input.agentId)) return [];
          const keyMessage = key ? message(key) : null;
          return [
            {
              conversationId: row.conversationId,
              summary: row.summary,
              startMessageId: row.startMessageId,
              startedAt: row.startedAt,
              endedAt: row.endedAt,
              similarity,
              ...(keyMessage?.conversationId === row.conversationId ? { keyMessage } : {}),
            },
          ];
        });
        if (result.length < input.limit && candidates.full)
          throw new Error('History segment candidate bound reached');
        return result.slice(0, input.limit);
      },
      { readOnly: true },
    );
  }

  async messages(input: HistorySearch): Promise<Array<HistoryMessage & { similarity: number }>> {
    const candidates = await this.candidates('messages', input);
    if (candidates.docs.length === 0) return [];
    return this.store.db.runTransaction(
      async (tx) => {
        const snapshots = await tx.getAll(...candidates.docs.map((doc) => doc.ref));
        const valid = snapshots.flatMap((snapshot, i) => {
          const candidate = candidates.docs[i];
          if (!candidate || !this.unchanged(snapshot, candidate)) return [];
          const row = message(snapshot),
            similarity = 1 - Number(candidate.get('vectorDistance'));
          if (
            !row ||
            !row.text ||
            !Number.isFinite(similarity) ||
            (row.conversationId === input.exclude.conversationId &&
              row.createdAt >= input.exclude.sinceCreatedAt)
          )
            return [];
          return [{ ...row, similarity }];
        });
        if (valid.length === 0) {
          if (candidates.full) throw new Error('History message candidate bound reached');
          return [];
        }
        const conversations = await tx.getAll(
          ...valid.map((row) => this.store.doc('conversations', row.conversationId)),
        );
        const result = valid.filter(
          (_, i) => conversations[i] && trusted(conversations[i], input.agentId),
        );
        if (result.length < input.limit && candidates.full)
          throw new Error('History message candidate bound reached');
        return result.slice(0, input.limit);
      },
      { readOnly: true },
    );
  }

  async neighborhood(
    input: Parameters<HistoryRecallRepository['neighborhood']>[0],
  ): Promise<HistoryMessage[]> {
    const { agentId, anchor, radius, exclude } = input;
    if (!Number.isInteger(radius) || radius < 0 || radius > 20)
      throw new Error('Invalid history neighborhood radius');
    return this.store.db.runTransaction(
      async (tx) => {
        const [conversation, snapshot] = await tx.getAll(
          this.store.doc('conversations', anchor.conversationId),
          this.store.doc('messages', anchor.id),
        );
        if (!conversation || !trusted(conversation, agentId) || !snapshot) return [];
        const current = message(snapshot);
        if (
          !current ||
          current.conversationId !== anchor.conversationId ||
          (current.conversationId === exclude.conversationId &&
            current.createdAt >= exclude.sinceCreatedAt)
        )
          return [];
        if (radius === 0) return [current];
        let base = this.store
          .collection('messages')
          .where('conversationId', '==', current.conversationId)
          .where('role', 'in', ['user', 'assistant']);
        if (current.conversationId === exclude.conversationId)
          base = base.where('createdAt', '<', exclude.sinceCreatedAt);
        const [before, after] = await Promise.all([
          tx.get(
            base
              .where('createdAt', '<', current.createdAt)
              .orderBy('createdAt', 'desc')
              .orderBy('id', 'desc')
              .limit(radius),
          ),
          tx.get(
            base
              .where('createdAt', '>', current.createdAt)
              .orderBy('createdAt', 'asc')
              .orderBy('id', 'asc')
              .limit(radius),
          ),
        ]);
        return [...before.docs.reverse(), snapshot, ...after.docs].flatMap((doc) => {
          const row = message(doc);
          return row && row.conversationId === current.conversationId ? [row] : [];
        });
      },
      { readOnly: true },
    );
  }

  async recentWindowStart({
    agentId,
    conversationId,
    size,
  }: Parameters<HistoryRecallRepository['recentWindowStart']>[0]): Promise<Date | null> {
    historyLimit(size);
    return this.store.db.runTransaction(
      async (tx) => {
        const conversation = await tx.get(this.store.doc('conversations', conversationId));
        if (!trusted(conversation, agentId)) return null;
        const rows = await tx.get(
          this.store
            .collection('messages')
            .where('conversationId', '==', conversationId)
            .where('role', 'in', ['user', 'assistant'])
            .orderBy('createdAt', 'desc')
            .orderBy('id', 'desc')
            .limit(size),
        );
        return rows.docs.at(-1)
          ? (message(rows.docs.at(-1) as QueryDocumentSnapshot)?.createdAt ?? null)
          : null;
      },
      { readOnly: true },
    );
  }
}
