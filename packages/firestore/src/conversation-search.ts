import {
  type ConversationSearchMatch,
  type ConversationSearchRepository,
  type EmbeddingSpace,
  historyLimit,
  type Records,
  validateEmbedding,
  validateSkillEmbeddingSpace,
} from '@assistant/persistence';
import type { QueryDocumentSnapshot } from '@google-cloud/firestore';
import { embeddingSpaceKey } from './memory.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const TEXT_PAGE_SIZE = 500;
/** The substring fallback reads newest messages first and fails rather than search a partial history. */
const TEXT_SCAN_LIMIT = 5000;

function match(doc: QueryDocumentSnapshot): ConversationSearchMatch | null {
  const row = decodeRecord<Records['messages']>(doc.data());
  if (
    typeof row.id !== 'string' ||
    documentKey(row.id) !== doc.id ||
    typeof row.conversationId !== 'string' ||
    typeof row.text !== 'string' ||
    !(row.createdAt instanceof Date)
  )
    return null;
  return { conversationId: row.conversationId, text: row.text, createdAt: row.createdAt };
}

/**
 * Message search for `conversations.search`. Messages carry no owner, so each
 * match is kept only when its conversation belongs to the requesting agent.
 * Like the SQL tool, every conversation of that owner is searchable; the tool
 * marks its results as untrusted content.
 */
export class FirestoreConversationSearchRepository implements ConversationSearchRepository {
  constructor(
    readonly store: InstallationStore,
    readonly space: EmbeddingSpace,
  ) {
    validateSkillEmbeddingSpace(space);
  }

  private async owned(agentId: string, conversationIds: string[]): Promise<Set<string>> {
    const unique = [...new Set(conversationIds)];
    const owned = new Set<string>();
    for (let offset = 0; offset < unique.length; offset += 200) {
      const ids = unique.slice(offset, offset + 200);
      const docs = await this.store.db.getAll(
        ...ids.map((id) => this.store.doc('conversations', id)),
      );
      docs.forEach((doc, index) => {
        const id = ids[index];
        if (
          id &&
          doc.exists &&
          doc.get('id') === id &&
          documentKey(id) === doc.id &&
          doc.get('agentId') === agentId
        )
          owned.add(id);
      });
    }
    return owned;
  }

  async semantic(
    input: Parameters<ConversationSearchRepository['semantic']>[0],
  ): Promise<Array<ConversationSearchMatch & { similarity: number }>> {
    historyLimit(input.limit);
    validateEmbedding(this.space, input.embedding);
    const candidateLimit = Math.min(200, input.limit * 4);
    const result = await this.store
      .collection('messages')
      .where('embeddingSpace', '==', embeddingSpaceKey(this.space))
      .findNearest({
        vectorField: 'embedding',
        queryVector: input.embedding,
        distanceMeasure: 'COSINE',
        limit: candidateLimit,
        distanceResultField: 'vectorDistance',
      })
      .get();
    const candidates = result.docs.flatMap((doc) => {
      const row = match(doc);
      const similarity = 1 - Number(doc.get('vectorDistance'));
      return row && Number.isFinite(similarity) ? [{ ...row, similarity }] : [];
    });
    const owned = await this.owned(
      input.agentId,
      candidates.map((row) => row.conversationId),
    );
    const rows = candidates.filter((row) => owned.has(row.conversationId));
    if (rows.length < input.limit && result.size === candidateLimit)
      throw new Error('Conversation search candidate bound reached');
    return rows.slice(0, input.limit);
  }

  async text(
    input: Parameters<ConversationSearchRepository['text']>[0],
  ): Promise<ConversationSearchMatch[]> {
    historyLimit(input.limit);
    const needle = input.query.toLocaleLowerCase();
    const matches: ConversationSearchMatch[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    for (let scanned = 0; scanned < TEXT_SCAN_LIMIT; ) {
      let query = this.store
        .collection('messages')
        .orderBy('createdAt', 'desc')
        .limit(TEXT_PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      scanned += page.size;
      const found = page.docs.flatMap((doc) => {
        const row = match(doc);
        return row?.text.toLocaleLowerCase().includes(needle) ? [row] : [];
      });
      const owned = await this.owned(
        input.agentId,
        found.map((row) => row.conversationId),
      );
      for (const row of found) {
        if (owned.has(row.conversationId)) matches.push(row);
        if (matches.length === input.limit) return matches;
      }
      if (page.size < TEXT_PAGE_SIZE) return matches;
      cursor = page.docs.at(-1);
    }
    throw new Error('Conversation text search scan bound reached');
  }
}
