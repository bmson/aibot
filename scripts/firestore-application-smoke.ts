import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createFirestoreCardRefreshRepository,
  FirestoreApplicationChatPersistence,
  FirestoreGeneratedCardRepository,
  type InstallationStore,
} from '@assistant/firestore';

/** Synthetic application-query smoke shared by emulator CI and real-cloud validation. */
export async function firestoreApplicationSmoke(store: InstallationStore): Promise<void> {
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const now = new Date();
  await store.doc('agents', agentId).set({
    id: agentId,
    name: 'Synthetic owner',
    timezone: 'UTC',
    createdAt: now,
    updatedAt: now,
  });
  const chat = new FirestoreApplicationChatPersistence(store);
  const first = await chat.createConversation(agentId);
  const second = await chat.createConversation(agentId);
  const stale = await chat.createConversation(agentId);

  const page = await chat.listConversations(agentId, { archived: false, limit: 1 });
  assert.equal(page.conversations.length, 1);
  assert.equal(page.hasMore, true);
  assert.ok(page.nextCursor);
  const nextPage = await chat.listConversations(agentId, {
    archived: false,
    limit: 2,
    after: page.nextCursor,
  });
  assert.ok(nextPage.conversations.length >= 1);
  assert.equal(await chat.countConversations(agentId, false), 3);

  const activeTaskId = randomUUID();
  await store.doc('tasks', activeTaskId).set({
    id: activeTaskId,
    agentId,
    conversationId: first.id,
    type: 'chat_turn',
    status: 'running',
    createdAt: now,
    updatedAt: now,
  });
  assert.deepEqual(await chat.listActiveConversationIds(agentId), [first.id]);
  assert.equal(await chat.countActiveTasks(agentId, first.id), 1);
  assert.equal(await chat.archiveConversation(agentId, first.id), 'active');
  assert.equal(await chat.archiveConversation(agentId, second.id), 'archived');
  assert.equal(await chat.countConversations(agentId, true), 1);
  assert.equal(await chat.restoreConversation(agentId, second.id), true);
  await store
    .doc('conversations', stale.id)
    .update({ updatedAt: new Date('2020-01-01T00:00:00Z') });
  assert.equal(
    await chat.archiveInactiveConversations(agentId, new Date('2021-01-01T00:00:00Z')),
    1,
  );

  const runtimeTaskId = randomUUID();
  const user = await chat.appendOwned(agentId, {
    conversationId: first.id,
    taskId: runtimeTaskId,
    role: 'user',
    origin: 'owner',
    parts: [{ type: 'text', text: 'Synthetic question' }],
    text: 'Synthetic question',
  });
  const assistant = await chat.appendOwned(agentId, {
    conversationId: first.id,
    taskId: runtimeTaskId,
    role: 'assistant',
    origin: 'assistant',
    parts: [{ type: 'text', text: 'Synthetic answer' }],
    text: 'Synthetic answer',
  });
  assert.ok(user && assistant);
  await store
    .doc('messages', assistant.id)
    .update({ createdAt: new Date(user.createdAt.getTime() + 1_000) });
  const initialMessages = await chat.listMessages(agentId, first.id, { limit: 1 });
  assert.equal(initialMessages?.messages.length, 1);
  const afterUser = await chat.listMessages(agentId, first.id, {
    limit: 2,
    after: { createdAt: user.createdAt, id: user.id },
  });
  assert.deepEqual(
    afterUser?.messages.map((message) => message.id),
    [assistant.id],
  );
  assert.deepEqual(
    (await chat.listRuntimeMessages(agentId, first.id, [runtimeTaskId]))?.map(
      (message) => message.id,
    ),
    [assistant.id],
  );
  assert.equal(await chat.setMessageHidden(agentId, first.id, assistant.id, true), true);
  assert.deepEqual(await chat.listMessagesByIds(agentId, first.id, [assistant.id]), []);
  assert.equal(await chat.setMessageHidden(agentId, first.id, assistant.id, false), true);

  const toolCallId = randomUUID();
  await store.doc('toolCalls', toolCallId).set({
    id: toolCallId,
    taskId: activeTaskId,
    toolName: 'synthetic.lookup',
    status: 'succeeded',
    step: 1,
    createdAt: now,
  });
  assert.deepEqual(await chat.listTaskActivity(agentId, first.id, activeTaskId), [
    { toolName: 'synthetic.lookup', status: 'succeeded', step: 1 },
  ]);
  await store.doc('models', 'synthetic-chat').set({
    id: 'synthetic-chat',
    label: 'Synthetic Chat',
    enabled: true,
    capabilities: {},
  });
  assert.deepEqual(await chat.listEnabledModels(), [
    { id: 'synthetic-chat', label: 'Synthetic Chat' },
  ]);

  const approvalId = randomUUID();
  const suggestionId = randomUUID();
  await store.doc('approvals', approvalId).set({
    id: approvalId,
    taskId: activeTaskId,
    summary: 'Synthetic approval',
    status: 'pending',
    payload: { safe: true },
    expiresAt: new Date(now.getTime() + 60_000),
  });
  await store.doc('suggestions', suggestionId).set({
    id: suggestionId,
    agentId,
    status: 'accepted',
    origin: 'synthetic',
    proposedAction: 'Inspect synthetic state',
    expiresAt: new Date(now.getTime() + 60_000),
    snoozedUntil: null,
    acceptedTaskId: activeTaskId,
  });
  const hydration = await chat.getHydrationState(agentId, {
    approvalIds: [approvalId],
    approvalTaskIds: [activeTaskId],
    budgetTaskIds: [activeTaskId],
    suggestionIds: [suggestionId],
  });
  assert.equal(hydration.approvals[0]?.id, approvalId);
  assert.equal(hydration.taskApprovals[0]?.taskId, activeTaskId);
  assert.equal(hydration.budgetTasks[0]?.id, activeTaskId);
  assert.equal(hydration.suggestions[0]?.acceptedTaskStatus, 'running');
  assert.deepEqual(
    await chat.getHydrationState(foreignAgentId, {
      approvalIds: [approvalId],
      approvalTaskIds: [activeTaskId],
      budgetTaskIds: [activeTaskId],
      suggestionIds: [suggestionId],
    }),
    { approvals: [], taskApprovals: [], budgetTasks: [], suggestions: [] },
  );

  const cards = new FirestoreGeneratedCardRepository(store);
  const cardId = randomUUID();
  const firstRevisionId = randomUUID();
  const created = await cards.createOrRevise({
    agentId,
    conversationId: first.id,
    id: cardId,
    revisionId: firstRevisionId,
    sourceFingerprint: `synthetic:${cardId}`,
    sourceLabel: 'Synthetic source',
    spec: { version: 1, title: 'First' },
    expiresAt: null,
  });
  assert.equal(created.revision.version, 1);
  const revised = await cards.createOrRevise({
    agentId,
    targetCardId: cardId,
    conversationId: first.id,
    id: randomUUID(),
    revisionId: randomUUID(),
    sourceFingerprint: `synthetic:${cardId}`,
    sourceLabel: 'Synthetic source',
    spec: { version: 1, title: 'Revised' },
    expiresAt: null,
  });
  assert.equal(revised.revision.version, 2);
  assert.equal((await cards.get(agentId, cardId))?.revision.id, revised.revision.id);
  assert.deepEqual(
    (await cards.list(agentId)).map((entry) => entry.card.id),
    [cardId],
  );
  const refreshTaskId = randomUUID();
  await store.doc('tasks', refreshTaskId).set({
    id: refreshTaskId,
    agentId,
    status: 'pending',
    type: 'card_refresh',
    trigger: { payload: { refreshCardId: cardId } },
    createdAt: now,
  });
  assert.deepEqual(
    (await cards.listRefreshes(agentId, [cardId])).map((task) => task.id),
    [refreshTaskId],
  );
  const refreshes = createFirestoreCardRefreshRepository(store);
  const formatInstruction = () => ({
    title: 'Refresh synthetic card',
    instruction: 'Read the synthetic source using read-only tools.',
  });
  const existingRefresh = await refreshes.request({
    agentId,
    cardId,
    conversationId: first.id,
    formatInstruction,
  });
  assert.equal(existingRefresh.ok && existingRefresh.taskId, refreshTaskId);
  assert.equal(existingRefresh.ok && existingRefresh.created, false);
  await store.doc('tasks', refreshTaskId).update({ status: 'done', updatedAt: new Date() });
  const newRefresh = await refreshes.request({
    agentId,
    cardId,
    conversationId: first.id,
    formatInstruction,
  });
  assert.equal(newRefresh.ok, true);
  assert.equal(newRefresh.ok && newRefresh.created, true);
  if (!newRefresh.ok) throw new Error('Synthetic refresh task was not created');
  const refreshTask = await store.doc('tasks', newRefresh.taskId).get();
  assert.equal(refreshTask.get('trigger.payload.refreshCardId'), cardId);
  const wake = await store
    .collection('outbox')
    .where('taskId', '==', newRefresh.taskId)
    .limit(1)
    .get();
  assert.equal(wake.size, 1);
  assert.equal(await cards.dismiss(foreignAgentId, cardId), false);
  assert.equal(await cards.dismiss(agentId, cardId), true);
  assert.equal(await cards.get(agentId, cardId), null);
}
