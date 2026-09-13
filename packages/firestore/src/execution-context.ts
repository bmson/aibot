import type {
  ExecutionContextRepository,
  ExecutionMessageCursor,
  Records,
} from '@assistant/persistence';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const MAX_SEED_MESSAGES = 20;
const MAX_FOLDED_REPLIES = 200;

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`Execution context limit must be between 1 and ${maximum}`);
  }
  return limit;
}

export class FirestoreExecutionContextRepository implements ExecutionContextRepository {
  readonly kind = 'execution-context-repository' as const;

  constructor(readonly store: InstallationStore) {}

  private async read<T extends { id: string }>(collection: string, id: string): Promise<T | null> {
    const snapshot = await this.store.doc(collection, id).get();
    if (!snapshot.exists) return null;
    const value = decodeRecord<T>(snapshot.data());
    return value.id === id && documentKey(value.id) === snapshot.ref.id ? value : null;
  }

  private decodeMessage(doc: FirebaseFirestore.QueryDocumentSnapshot): Records['messages'] {
    const row = decodeRecord<Records['messages']>(doc.data());
    if (documentKey(row.id) !== doc.id) {
      throw new Error('Execution context message document identity mismatch');
    }
    return row;
  }

  private async ownedConversation(agentId: string, conversationId: string) {
    const conversation = await this.read<Records['conversations']>('conversations', conversationId);
    return conversation?.agentId === agentId ? conversation : null;
  }

  async getAgent(agentId: string) {
    return this.read<Records['agents']>('agents', agentId);
  }

  async getTask(agentId: string, taskId: string) {
    const row = await this.read<Records['tasks']>('tasks', taskId);
    return row?.agentId === agentId ? row : null;
  }

  async getGoalStopState(agentId: string, goalId: string) {
    const row = await this.read<Records['goals']>('goals', goalId);
    return row?.agentId === agentId ? { status: row.status, archivedAt: row.archivedAt } : null;
  }

  async seedHistory({
    agentId,
    conversationId,
    before,
    limit: requestedLimit,
  }: {
    agentId: string;
    conversationId: string;
    before: Date;
    limit?: number;
  }) {
    const limit = boundedLimit(requestedLimit, MAX_SEED_MESSAGES, MAX_SEED_MESSAGES);
    if (!(await this.ownedConversation(agentId, conversationId))) return [];
    const snapshot = await this.store
      .collection('messages')
      .where('conversationId', '==', conversationId)
      .where('role', 'in', ['user', 'assistant'])
      .where('createdAt', '<', before)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => this.decodeMessage(doc)).reverse();
  }

  async getInboundMessage({
    agentId,
    conversationId,
    channelMessageId,
  }: {
    agentId: string;
    conversationId: string;
    channelMessageId: string;
  }) {
    if (!(await this.ownedConversation(agentId, conversationId))) return null;
    const snapshot = await this.store
      .collection('messages')
      .where('conversationId', '==', conversationId)
      .where('channelMessageId', '==', channelMessageId)
      .limit(2)
      .get();
    if (snapshot.size > 1) throw new Error('Ambiguous inbound execution message');
    const doc = snapshot.docs[0];
    if (!doc) return null;
    const row = this.decodeMessage(doc);
    return row.conversationId === conversationId && row.channelMessageId === channelMessageId
      ? { text: row.text }
      : null;
  }

  async getLatestOwnerReplyCursor({
    agentId,
    conversationId,
  }: {
    agentId: string;
    conversationId: string;
  }): Promise<{ cursor: ExecutionMessageCursor | null } | null> {
    const conversation = await this.ownedConversation(agentId, conversationId);
    if (conversation?.channel !== 'chat') return null;
    const snapshot = await this.store
      .collection('messages')
      .where('conversationId', '==', conversationId)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .get();
    const doc = snapshot.docs[0];
    if (!doc) return { cursor: null };
    const row = this.decodeMessage(doc);
    if (row.conversationId !== conversationId) {
      throw new Error('Execution context message scope mismatch');
    }
    return { cursor: { createdAt: row.createdAt, id: row.id } };
  }

  async getOwnerRepliesAfter({
    agentId,
    conversationId,
    after,
    limit: requestedLimit,
  }: {
    agentId: string;
    conversationId: string;
    after: { createdAt: Date; id?: string };
    limit?: number;
  }) {
    const limit = boundedLimit(requestedLimit, MAX_FOLDED_REPLIES, MAX_FOLDED_REPLIES);
    const conversation = await this.ownedConversation(agentId, conversationId);
    if (conversation?.channel !== 'chat') return [];
    let query = this.store
      .collection('messages')
      .where('conversationId', '==', conversationId)
      .where('role', '==', 'user')
      .where('origin', '==', 'owner')
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc');
    query = after.id
      ? query.startAfter(after.createdAt, after.id)
      : query.where('createdAt', '>', after.createdAt);
    const snapshot = await query.limit(limit + 1).get();
    if (snapshot.size > limit) {
      throw new Error(`Owner reply window exceeded ${limit} messages`);
    }
    return snapshot.docs.map((doc) => {
      const row = this.decodeMessage(doc);
      if (row.conversationId !== conversationId || row.role !== 'user' || row.origin !== 'owner') {
        throw new Error('Execution context owner reply scope mismatch');
      }
      return row;
    });
  }

  async noticeIds(
    agentId: string,
    rows: ReadonlyArray<{
      id: string;
      role: string;
      taskId: string | null;
      parts: unknown;
    }>,
  ) {
    const notices = new Set<string>();
    const pending = new Map<string, string[]>();
    for (const row of rows) {
      if (row.role !== 'assistant') continue;
      if (hasNoticePart(row.parts)) {
        notices.add(row.id);
        continue;
      }
      if (!row.taskId) continue;
      pending.set(row.taskId, [...(pending.get(row.taskId) ?? []), row.id]);
    }
    for (const [taskId, messageIds] of pending) {
      const task = await this.read<Records['tasks']>('tasks', taskId);
      if (task?.agentId !== agentId || task.type === 'chat_turn') continue;
      for (const id of messageIds) notices.add(id);
    }
    return notices;
  }
}

/** Keep this in lockstep with core/chat.ts; repositories cannot import core. */
const NOTICE_PART_TYPES = new Set(['notice', 'suggestion', 'approval-summary']);

function hasNoticePart(parts: unknown): boolean {
  if (!Array.isArray(parts)) return false;
  return parts.some((part) => {
    if (!part || typeof part !== 'object') return false;
    const { type, data } = part as { type?: unknown; data?: unknown };
    if (typeof type !== 'string') return false;
    if (NOTICE_PART_TYPES.has(type)) return true;
    if (type !== 'data-card' || !data || typeof data !== 'object') return false;
    return (data as { kind?: unknown }).kind === 'proactive-alert';
  });
}
