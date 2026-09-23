import { randomUUID } from 'node:crypto';
import type {
  ApplicationChatApproval,
  ApplicationChatConversation,
  ApplicationChatHydrationState,
  ApplicationChatMessage,
  ApplicationChatPersistence,
  TaskLease,
} from '@assistant/persistence';
import {
  boundedChatConversationLimit,
  boundedChatMessageLimit,
  newTaskRecord,
} from '@assistant/persistence';
import { type Query, type QueryDocumentSnapshot, Timestamp } from '@google-cloud/firestore';
import { FirestoreExecutionEvidenceRepository } from './execution-evidence.js';
import { createWakeIntent } from './outbox.js';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'];
const MAX_ACTIVE_TASKS = 500;
const MAX_MODELS = 100;
const MAX_LOOKUP_IDS = 200;
const GOAL_BLOCKED_PREFIX = 'Waiting on the owner:';
const DIRECT_CHAT_LEASE_MS = 10 * 60_000;

function conciseTitle(value: string | undefined): string | undefined {
  const title = value?.replace(/\s+/g, ' ').trim() ?? '';
  if (!title) return undefined;
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

function decodeConversation(snapshot: QueryDocumentSnapshot): ApplicationChatConversation {
  return decodeRecord<ApplicationChatConversation>(snapshot.data());
}

function decodeMessage(snapshot: QueryDocumentSnapshot): ApplicationChatMessage {
  const message = decodeRecord<ApplicationChatMessage>(snapshot.data());
  const createdAt = snapshot.get('createdAt');
  if (!(createdAt instanceof Timestamp)) return message;
  const wholeSecond = new Date(Number(createdAt.seconds) * 1_000)
    .toISOString()
    .slice(0, 'YYYY-MM-DDTHH:mm:ss'.length);
  return {
    ...message,
    createdAtExact: `${wholeSecond}.${String(createdAt.nanoseconds).padStart(9, '0')}Z`,
  };
}

function cursorTimestamp(createdAt: Date, createdAtExact?: string): Date | Timestamp {
  if (!createdAtExact) return createdAt;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{1,9})Z$/.exec(createdAtExact);
  if (!match) return createdAt;
  const [, wholeSecond, fraction] = match;
  if (!wholeSecond || !fraction) return createdAt;
  const seconds = Date.parse(`${wholeSecond}Z`) / 1_000;
  if (!Number.isSafeInteger(seconds)) return createdAt;
  return new Timestamp(seconds, Number(fraction.padEnd(9, '0')));
}

function chunks<T>(values: T[], size = 30): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function boundedIds(values: string[]): string[] {
  const unique = [...new Set(values)];
  if (unique.length > MAX_LOOKUP_IDS) throw new Error('Chat lookup exceeds bounded page size');
  return unique;
}

function isOwnedChat(data: FirebaseFirestore.DocumentData | undefined, agentId: string): boolean {
  return Boolean(data && data.agentId === agentId && data.channel === 'chat');
}

/** Firestore adapter for the owner-facing application chat read/write model. */
export class FirestoreApplicationChatPersistence implements ApplicationChatPersistence {
  readonly kind = 'application-chat-persistence' as const;

  constructor(readonly store: InstallationStore) {}

  async resolveAgent() {
    const snapshot = await this.store
      .collection('agents')
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .limit(1)
      .get();
    const first = snapshot.docs[0];
    if (!first) throw new Error('no agent row — run pnpm seed');
    return decodeRecord<Awaited<ReturnType<ApplicationChatPersistence['resolveAgent']>>>(
      first.data(),
    );
  }

  async getOrCreatePrimaryConversation(agentId: string) {
    return this.store.db.runTransaction(async (tx) => {
      const primarySnapshot = await tx.get(
        this.store
          .collection('conversations')
          .where('agentId', '==', agentId)
          .where('isPrimary', '==', true)
          .limit(1),
      );
      const primary = primarySnapshot.docs[0];
      if (primary && isOwnedChat(primary.data(), agentId)) {
        const conversation = decodeConversation(primary);
        if (conversation.archivedAt) {
          const now = this.store.now();
          tx.update(primary.ref, { archivedAt: null, archived: false, updatedAt: now });
          return { ...conversation, archivedAt: null, updatedAt: now };
        }
        return conversation;
      }

      const candidates = await tx.get(
        this.store
          .collection('conversations')
          .where('agentId', '==', agentId)
          .where('channel', '==', 'chat')
          .where('archived', '==', false)
          .orderBy('updatedAt', 'desc')
          .orderBy('id', 'desc'),
      );
      const recent = candidates.docs.find(
        (document) =>
          isOwnedChat(document.data(), agentId) &&
          !(document.get('metadata') as Record<string, unknown> | undefined)?.goalId,
      );
      if (recent) {
        const conversation = decodeConversation(recent);
        const now = this.store.now();
        tx.update(recent.ref, { isPrimary: true, updatedAt: now });
        return { ...conversation, isPrimary: true, updatedAt: now };
      }

      const id = randomUUID();
      const now = this.store.now();
      const created: ApplicationChatConversation = {
        id,
        agentId,
        channel: 'chat',
        title: '',
        trust: 'owner',
        modelOverride: null,
        isPrimary: true,
        metadata: {},
        archivedAt: null,
        lastReadAt: null,
        createdAt: now,
        updatedAt: now,
      };
      tx.create(this.store.doc('conversations', id), encodeRecord({ ...created, archived: false }));
      return created;
    });
  }

  async createConversation(agentId: string) {
    const id = randomUUID();
    const now = this.store.now();
    const row: ApplicationChatConversation = {
      id,
      agentId,
      channel: 'chat',
      title: '',
      trust: 'owner',
      modelOverride: null,
      isPrimary: false,
      metadata: {},
      archivedAt: null,
      lastReadAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.doc('conversations', id).create(encodeRecord({ ...row, archived: false }));
    return row;
  }

  async getConversation(agentId: string, conversationId: string) {
    const snapshot = await this.store.doc('conversations', conversationId).get();
    if (!snapshot.exists || !isOwnedChat(snapshot.data(), agentId)) return null;
    return decodeRecord<ApplicationChatConversation>(snapshot.data());
  }

  async listConversations(
    agentId: string,
    input: Parameters<ApplicationChatPersistence['listConversations']>[1],
  ) {
    const limit = boundedChatConversationLimit(input.limit);
    let query: Query = this.store
      .collection('conversations')
      .where('agentId', '==', agentId)
      .where('channel', '==', 'chat')
      .where('archived', '==', input.archived)
      .orderBy('updatedAt', 'desc')
      .orderBy('id', 'desc');
    if (input.after) query = query.startAfter(input.after.updatedAt, input.after.id);
    const snapshot = await query.limit(limit + 1).get();
    const rows = snapshot.docs.slice(0, limit).map(decodeConversation);
    const tail = rows.at(-1);
    return {
      conversations: rows,
      hasMore: snapshot.size > limit,
      nextCursor: tail ? { updatedAt: tail.updatedAt, id: tail.id } : null,
    };
  }

  async countConversations(agentId: string, archived: boolean) {
    const snapshot = await this.store
      .collection('conversations')
      .where('agentId', '==', agentId)
      .where('channel', '==', 'chat')
      .where('archived', '==', archived)
      .count()
      .get();
    return snapshot.data().count;
  }

  async listActiveConversationIds(agentId: string) {
    const snapshot = await this.store
      .collection('tasks')
      .where('agentId', '==', agentId)
      .where('status', 'not-in', TERMINAL_TASK_STATUSES)
      .limit(MAX_ACTIVE_TASKS + 1)
      .get();
    if (snapshot.size > MAX_ACTIVE_TASKS)
      throw new Error('Active chat task set exceeds safety bound');
    return [
      ...new Set(
        snapshot.docs
          .map((doc) => doc.get('conversationId'))
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];
  }

  async archiveConversation(agentId: string, conversationId: string) {
    return this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('conversations', conversationId);
      const conversation = await tx.get(ref);
      if (!conversation.exists || !isOwnedChat(conversation.data(), agentId)) {
        throw new Error('chat not found');
      }
      if (conversation.get('isPrimary') === true) return 'primary' as const;
      const active = await tx.get(
        this.store
          .collection('tasks')
          .where('agentId', '==', agentId)
          .where('conversationId', '==', conversationId)
          .where('status', 'not-in', TERMINAL_TASK_STATUSES)
          .limit(1),
      );
      if (!active.empty) return 'active' as const;
      const now = this.store.now();
      tx.update(ref, { archivedAt: now, archived: true, updatedAt: now });
      return 'archived' as const;
    });
  }

  async restoreConversation(agentId: string, conversationId: string) {
    return this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('conversations', conversationId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || !isOwnedChat(snapshot.data(), agentId)) return false;
      if (snapshot.get('archivedAt') === null) return false;
      tx.update(ref, { archivedAt: null, archived: false, updatedAt: this.store.now() });
      return true;
    });
  }

  async archiveInactiveConversations(agentId: string, olderThan: Date, requestedLimit = 100) {
    const limit = boundedChatConversationLimit(requestedLimit);
    const candidates = await this.store
      .collection('conversations')
      .where('agentId', '==', agentId)
      .where('channel', '==', 'chat')
      .where('isPrimary', '==', false)
      .where('archived', '==', false)
      .where('updatedAt', '<', olderThan)
      .orderBy('updatedAt', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .get();
    let archived = 0;
    for (const candidate of candidates.docs) {
      archived += await this.store.db.runTransaction(async (tx) => {
        const current = await tx.get(candidate.ref);
        if (
          !current.exists ||
          !isOwnedChat(current.data(), agentId) ||
          current.get('isPrimary') === true ||
          current.get('archivedAt') !== null ||
          (decodeRecord<Date>(current.get('updatedAt'))?.getTime?.() ?? Number.POSITIVE_INFINITY) >=
            olderThan.getTime()
        ) {
          return 0;
        }
        const active = await tx.get(
          this.store
            .collection('tasks')
            .where('agentId', '==', agentId)
            .where('conversationId', '==', candidate.get('id'))
            .where('status', 'not-in', TERMINAL_TASK_STATUSES)
            .limit(1),
        );
        if (!active.empty) return 0;
        const now = this.store.now();
        tx.update(candidate.ref, { archivedAt: now, archived: true, updatedAt: now });
        return 1;
      });
    }
    return archived;
  }

  async setConversationModel(agentId: string, conversationId: string, modelId: string | null) {
    return this.updateOwned(agentId, conversationId, {
      modelOverride: modelId,
      updatedAt: this.store.now(),
    });
  }

  async setConversationTitleIfEmpty(agentId: string, conversationId: string, title: string) {
    return this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('conversations', conversationId);
      const snapshot = await tx.get(ref);
      if (
        !snapshot.exists ||
        !isOwnedChat(snapshot.data(), agentId) ||
        snapshot.get('title') !== ''
      ) {
        return false;
      }
      tx.update(ref, { title });
      return true;
    });
  }

  async markConversationRead(
    agentId: string,
    conversationId: string,
    readAt: Date,
    settleSeconds = 30,
  ) {
    return this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('conversations', conversationId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || !isOwnedChat(snapshot.data(), agentId)) return false;
      const lastReadAt = snapshot.get('lastReadAt');
      const lastRead = lastReadAt ? decodeRecord<Date>(lastReadAt) : null;
      if (lastRead && lastRead.getTime() >= readAt.getTime() - Math.max(0, settleSeconds) * 1000) {
        return false;
      }
      tx.update(ref, { lastReadAt: readAt });
      return true;
    });
  }

  async getGoalTitle(agentId: string, goalId: string) {
    const snapshot = await this.store.doc('goals', goalId).get();
    return snapshot.exists && snapshot.get('agentId') === agentId
      ? String(snapshot.get('title') ?? '')
      : null;
  }

  async clearGoalBlockedOnOwnerReply(agentId: string, goalId: string) {
    await this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('goals', goalId);
      const snapshot = await tx.get(ref);
      if (
        !snapshot.exists ||
        snapshot.get('agentId') !== agentId ||
        !String(snapshot.get('nextAction') ?? '').startsWith(GOAL_BLOCKED_PREFIX)
      ) {
        return;
      }
      tx.update(ref, { nextAction: '', updatedAt: this.store.now() });
    });
  }

  async countActiveTasks(agentId: string, conversationId: string) {
    const snapshot = await this.store
      .collection('tasks')
      .where('agentId', '==', agentId)
      .where('conversationId', '==', conversationId)
      .where('status', 'not-in', TERMINAL_TASK_STATUSES)
      .count()
      .get();
    return snapshot.data().count;
  }

  async getTaskStatus(agentId: string, conversationId: string, taskId: string) {
    const snapshot = await this.store.doc('tasks', taskId).get();
    return snapshot.exists &&
      snapshot.get('agentId') === agentId &&
      snapshot.get('conversationId') === conversationId
      ? String(snapshot.get('status'))
      : null;
  }

  async listTaskActivity(
    agentId: string,
    conversationId: string,
    taskId: string,
    requestedLimit = 3,
  ) {
    if ((await this.getTaskStatus(agentId, conversationId, taskId)) === null) return [];
    const limit = Math.max(1, Math.min(10, Math.floor(requestedLimit)));
    const snapshot = await this.store
      .collection('toolCalls')
      .where('taskId', '==', taskId)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs
      .map((doc) => ({
        toolName: String(doc.get('toolName')),
        status: String(doc.get('status')),
        step: Number(doc.get('step')),
      }))
      .reverse();
  }

  async listEnabledModels() {
    const snapshot = await this.store
      .collection('models')
      .where('enabled', '==', true)
      .orderBy('label', 'asc')
      .limit(MAX_MODELS + 1)
      .get();
    if (snapshot.size > MAX_MODELS) throw new Error('Enabled model set exceeds safety bound');
    return snapshot.docs
      .filter((doc) => doc.get('capabilities.embedding') !== true)
      .map((doc) => ({ id: String(doc.get('id')), label: String(doc.get('label')) }));
  }

  async listMessages(
    agentId: string,
    conversationId: string,
    input: Parameters<ApplicationChatPersistence['listMessages']>[2] = {},
  ) {
    if (!(await this.getConversation(agentId, conversationId))) return null;
    const limit = boundedChatMessageLimit(input.limit);
    let query: Query = this.store
      .collection('messages')
      .where('conversationId', '==', conversationId)
      .where('hiddenAt', '==', null);
    if (input.after) {
      query = query
        .orderBy('createdAt', 'asc')
        .orderBy('id', 'asc')
        .startAfter(
          cursorTimestamp(input.after.createdAt, input.after.createdAtExact),
          input.after.id,
        )
        .limit(limit + 1);
      const snapshot = await query.get();
      return {
        messages: snapshot.docs.slice(0, limit).map(decodeMessage),
        hasMore: snapshot.size > limit,
      };
    }
    const snapshot = await query
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .get();
    return { messages: snapshot.docs.map(decodeMessage).reverse(), hasMore: false };
  }

  async listMessagesByIds(agentId: string, conversationId: string, rawIds: string[]) {
    if (!(await this.getConversation(agentId, conversationId))) return null;
    const ids = boundedIds(rawIds);
    if (!ids.length) return [];
    const snapshots = await this.store.db.getAll(
      ...ids.map((id) => this.store.doc('messages', id)),
    );
    return snapshots
      .filter(
        (snapshot) =>
          snapshot.exists &&
          snapshot.get('conversationId') === conversationId &&
          snapshot.get('hiddenAt') === null,
      )
      .map((snapshot) => decodeRecord<ApplicationChatMessage>(snapshot.data()))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  async listRuntimeMessages(
    agentId: string,
    conversationId: string,
    rawTaskIds: string[],
    requestedLimit = 200,
  ) {
    if (!(await this.getConversation(agentId, conversationId))) return null;
    const taskIds = boundedIds(rawTaskIds);
    if (!taskIds.length) return [];
    const limit = boundedChatMessageLimit(requestedLimit);
    const pages = await Promise.all(
      chunks(taskIds).map((ids) =>
        this.store
          .collection('messages')
          .where('conversationId', '==', conversationId)
          .where('taskId', 'in', ids)
          .where('role', '==', 'assistant')
          .where('hiddenAt', '==', null)
          .orderBy('createdAt', 'asc')
          .orderBy('id', 'asc')
          .limit(limit)
          .get(),
      ),
    );
    const rows = pages
      .flatMap((page) => page.docs.map(decodeMessage))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    return rows.slice(0, limit);
  }

  async setMessageHidden(
    agentId: string,
    conversationId: string,
    messageId: string,
    hidden: boolean,
  ) {
    return this.store.db.runTransaction(async (tx) => {
      const conversation = await tx.get(this.store.doc('conversations', conversationId));
      if (!conversation.exists || !isOwnedChat(conversation.data(), agentId)) return false;
      const ref = this.store.doc('messages', messageId);
      const message = await tx.get(ref);
      if (!message.exists || message.get('conversationId') !== conversationId) return false;
      tx.update(ref, { hiddenAt: hidden ? this.store.now() : null });
      return true;
    });
  }

  async getTaskKinds(agentId: string, rawTaskIds: string[]) {
    const ids = boundedIds(rawTaskIds);
    if (!ids.length) return new Map();
    const snapshots = await this.store.db.getAll(...ids.map((id) => this.store.doc('tasks', id)));
    return new Map(
      snapshots
        .filter((snapshot) => snapshot.exists && snapshot.get('agentId') === agentId)
        .map((snapshot) => [String(snapshot.get('id')), String(snapshot.get('type'))]),
    );
  }

  async getHydrationState(
    agentId: string,
    input: Parameters<ApplicationChatPersistence['getHydrationState']>[1],
  ): Promise<ApplicationChatHydrationState> {
    const approvalIds = boundedIds(input.approvalIds);
    const approvalTaskIds = boundedIds(input.approvalTaskIds);
    const budgetTaskIds = boundedIds(input.budgetTaskIds);
    const suggestionIds = boundedIds(input.suggestionIds);
    const [approvalDocs, taskApprovalPages, budgetDocs, suggestionDocs] = await Promise.all([
      approvalIds.length
        ? this.store.db.getAll(...approvalIds.map((id) => this.store.doc('approvals', id)))
        : [],
      Promise.all(
        chunks(approvalTaskIds).map((ids) =>
          this.store
            .collection('approvals')
            .where('taskId', 'in', ids)
            .limit(MAX_LOOKUP_IDS + 1)
            .get(),
        ),
      ),
      budgetTaskIds.length
        ? this.store.db.getAll(...budgetTaskIds.map((id) => this.store.doc('tasks', id)))
        : [],
      suggestionIds.length
        ? this.store.db.getAll(...suggestionIds.map((id) => this.store.doc('suggestions', id)))
        : [],
    ]);
    if (taskApprovalPages.some((page) => page.size > MAX_LOOKUP_IDS)) {
      throw new Error('Approval hydration exceeds bounded page size');
    }
    const rawApprovals = [
      ...new Map(
        [
          ...approvalDocs.filter((doc) => doc.exists),
          ...taskApprovalPages.flatMap((page) => page.docs),
        ].map((doc) => [doc.id, doc]),
      ).values(),
    ];
    const approvalTaskRefs = boundedIds(
      rawApprovals
        .map((doc) => doc.get('taskId'))
        .filter((id): id is string => typeof id === 'string'),
    );
    const approvalTasks = approvalTaskRefs.length
      ? await this.store.db.getAll(...approvalTaskRefs.map((id) => this.store.doc('tasks', id)))
      : [];
    const acceptedTaskRefs = boundedIds(
      suggestionDocs
        .map((doc) => doc.get('acceptedTaskId'))
        .filter((id): id is string => typeof id === 'string'),
    );
    const acceptedTasks = acceptedTaskRefs.length
      ? await this.store.db.getAll(...acceptedTaskRefs.map((id) => this.store.doc('tasks', id)))
      : [];
    const acceptedTaskById = new Map(
      acceptedTasks
        .filter((doc) => doc.exists && doc.get('agentId') === agentId)
        .map((doc) => [String(doc.get('id')), doc]),
    );
    const ownedTaskIds = new Set(
      approvalTasks
        .filter((doc) => doc.exists && doc.get('agentId') === agentId)
        .map((doc) => String(doc.get('id'))),
    );
    const decodeApproval = (doc: FirebaseFirestore.DocumentSnapshot): ApplicationChatApproval => ({
      id: String(doc.get('id')),
      taskId: String(doc.get('taskId')),
      summary: String(doc.get('summary')),
      status: String(doc.get('status')),
      payload: decodeRecord(doc.get('payload')),
      expiresAt: decodeRecord<Date>(doc.get('expiresAt')),
    });
    const directIdSet = new Set(approvalIds);
    const approvals = rawApprovals
      .filter(
        (doc) =>
          directIdSet.has(String(doc.get('id'))) && ownedTaskIds.has(String(doc.get('taskId'))),
      )
      .map(decodeApproval);
    const taskApprovals = rawApprovals
      .filter(
        (doc) =>
          approvalTaskIds.includes(String(doc.get('taskId'))) &&
          ownedTaskIds.has(String(doc.get('taskId'))),
      )
      .map(decodeApproval);
    return {
      approvals,
      taskApprovals,
      budgetTasks: budgetDocs
        .filter((doc) => doc.exists && doc.get('agentId') === agentId)
        .map((doc) => ({
          id: String(doc.get('id')),
          status: String(doc.get('status')),
          budgetUsdLimit: String(doc.get('budgetUsdLimit')),
        })),
      suggestions: suggestionDocs
        .filter((doc) => doc.exists && doc.get('agentId') === agentId)
        .map((doc) => {
          const acceptedTaskId =
            typeof doc.get('acceptedTaskId') === 'string'
              ? String(doc.get('acceptedTaskId'))
              : null;
          const acceptedTask = acceptedTaskId ? acceptedTaskById.get(acceptedTaskId) : undefined;
          return {
            id: String(doc.get('id')),
            status: String(doc.get('status')),
            expiresAt: decodeRecord<Date>(doc.get('expiresAt')),
            origin: String(doc.get('origin') ?? ''),
            proposedAction: String(doc.get('proposedAction') ?? ''),
            snoozedUntil: doc.get('snoozedUntil')
              ? decodeRecord<Date>(doc.get('snoozedUntil'))
              : null,
            acceptedTaskId,
            acceptedTaskStatus: acceptedTask ? String(acceptedTask.get('status')) : null,
            acceptedTaskProgress: acceptedTask ? String(acceptedTask.get('progress') ?? '') : null,
            acceptedTaskConversationId:
              acceptedTask && typeof acceptedTask.get('conversationId') === 'string'
                ? String(acceptedTask.get('conversationId'))
                : null,
          };
        }),
    };
  }

  async appendOwned(
    agentId: string,
    input: Parameters<ApplicationChatPersistence['appendOwned']>[1],
  ) {
    const id = randomUUID();
    const conversation = this.store.doc('conversations', input.conversationId);
    const dedupe = input.channelMessageId
      ? this.store.doc('messageChannelIds', input.channelMessageId)
      : null;
    return this.store.db.runTransaction(async (tx) => {
      const parent = await tx.get(conversation);
      if (!parent.exists || !isOwnedChat(parent.data(), agentId)) throw new Error('chat not found');
      const existing = dedupe ? await tx.get(dedupe) : null;
      if (existing?.exists) {
        if (existing.get('conversationId') !== input.conversationId) {
          throw new Error('Channel message ID belongs to another conversation');
        }
        return undefined;
      }
      const now = this.store.now();
      const row: ApplicationChatMessage = {
        ...input,
        id,
        createdAt: now,
        taskId: input.taskId ?? null,
        channelMessageId: input.channelMessageId ?? null,
        embedding: null,
        hiddenAt: null,
      };
      if (Buffer.byteLength(JSON.stringify(row), 'utf8') > 900_000) {
        throw new Error('Message exceeds inline storage limit; store its payload in Cloud Storage');
      }
      tx.create(this.store.doc('messages', id), encodeRecord(row));
      if (dedupe) tx.create(dedupe, { messageId: id, conversationId: input.conversationId });
      tx.update(conversation, { updatedAt: now });
      return row;
    });
  }

  async createDirectChatTask(input: {
    agentId: string;
    conversationId: string;
    goalId?: string;
    title?: string;
  }) {
    const id = randomUUID();
    return this.store.db.runTransaction(async (tx) => {
      const conversation = await tx.get(this.store.doc('conversations', input.conversationId));
      if (!conversation.exists || !isOwnedChat(conversation.data(), input.agentId)) {
        throw new Error('chat not found');
      }
      const budget = await tx.get(this.store.doc('budgets', 'task_default'));
      const now = this.store.now();
      const task = newTaskRecord(
        {
          agentId: input.agentId,
          conversationId: input.conversationId,
          type: 'chat_turn',
          trust: 'owner',
          budgetUsdLimit: budget.get('limitUsd') ?? '0.50',
          goalId: input.goalId,
          title: conciseTitle(input.title),
          trigger: { source: 'chat', conversationId: input.conversationId },
        },
        id,
        now,
      );
      const lease: TaskLease = {
        ...task,
        status: 'running',
        updatedAt: now,
        lockedUntil: new Date(now.getTime() + DIRECT_CHAT_LEASE_MS),
        leaseToken: randomUUID(),
      };
      tx.create(this.store.doc('tasks', id), encodeRecord(lease));
      return lease;
    });
  }

  async completeDirectChatTask(input: {
    agentId: string;
    task: TaskLease;
    status: 'done' | 'failed';
    progress?: string;
    messages: Parameters<ApplicationChatPersistence['appendOwned']>[1][];
  }) {
    return this.store.db.runTransaction(async (tx) => {
      const taskRef = this.store.doc('tasks', input.task.id);
      const taskSnapshot = await tx.get(taskRef);
      if (!taskSnapshot.exists) return false;
      const task = decodeRecord<TaskLease>(taskSnapshot.data());
      const now = this.store.now();
      if (
        task.agentId !== input.agentId ||
        task.status !== 'running' ||
        !input.task.leaseToken ||
        task.leaseToken !== input.task.leaseToken ||
        !task.lockedUntil ||
        task.lockedUntil <= now
      ) {
        return false;
      }
      const conversationRef = task.conversationId
        ? this.store.doc('conversations', task.conversationId)
        : null;
      const conversation = conversationRef ? await tx.get(conversationRef) : null;
      if (
        conversation &&
        (!conversation.exists || !isOwnedChat(conversation.data(), input.agentId))
      ) {
        throw new Error('Chat completion conversation is outside the owner scope');
      }
      for (const message of input.messages) {
        if (message.conversationId !== task.conversationId || message.taskId !== task.id) {
          throw new Error('Chat completion message does not match its task');
        }
      }
      tx.update(
        taskRef,
        encodeRecord({
          status: input.status,
          progress: input.progress,
          lockedUntil: null,
          leaseToken: null,
          updatedAt: now,
        }),
      );
      for (const message of input.messages) {
        const id = randomUUID();
        const row: ApplicationChatMessage = {
          ...message,
          id,
          createdAt: now,
          taskId: message.taskId ?? null,
          channelMessageId: message.channelMessageId ?? null,
          embedding: null,
          hiddenAt: null,
        };
        tx.create(this.store.doc('messages', id), encodeRecord(row));
      }
      if (conversationRef && input.messages.length) tx.update(conversationRef, { updatedAt: now });
      return true;
    });
  }

  async raiseTaskBudget(agentId: string, taskId: string, requested: number) {
    if (!Number.isFinite(requested) || requested < 0.01 || requested > 10_000) {
      throw new Error('task budget must be between $0.01 and $10,000');
    }
    await this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('tasks', taskId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('agentId') !== agentId) {
        throw new Error('activity item not found');
      }
      const task = decodeRecord<TaskLease>(snapshot.data());
      if (task.status !== 'needs_attention') throw new Error('only stalled tasks can be retried');
      if (requested <= Number(task.budgetUsdLimit) || requested < Number(task.spentUsd)) {
        throw new Error('new task budget must be above its current cap and spend');
      }
      const now = this.store.now();
      const queueGeneration = task.queueGeneration + 1;
      tx.update(
        ref,
        encodeRecord({
          status: 'pending',
          budgetUsdLimit: requested.toFixed(4),
          runAfter: null,
          lockedUntil: null,
          leaseToken: null,
          queueGeneration,
          updatedAt: now,
        }),
      );
      createWakeIntent(tx, this.store, { taskId, generation: queueGeneration, availableAt: now });
    });
  }

  listConversationEvidence(agentId: string, conversationId: string, excludeTaskId: string) {
    return new FirestoreExecutionEvidenceRepository(this.store).conversationEvidence({
      agentId,
      conversationId,
      excludeTaskId,
    });
  }

  private async updateOwned(
    agentId: string,
    conversationId: string,
    patch: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>,
  ) {
    return this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('conversations', conversationId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || !isOwnedChat(snapshot.data(), agentId)) return false;
      tx.update(ref, patch);
      return true;
    });
  }
}
