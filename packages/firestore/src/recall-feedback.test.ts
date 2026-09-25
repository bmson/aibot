import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreRecallFeedbackRepository } from './recall-feedback.js';
import { encodeRecord, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore recall feedback', () => {
  let store: InstallationStore;
  let repository: FirestoreRecallFeedbackRepository;
  const agentId = randomUUID();
  const conversationId = randomUUID();
  const foreignConversationId = randomUUID();

  beforeEach(async () => {
    store = emulatorStore(() => new Date('2026-09-23T12:00:00.000Z'));
    repository = new FirestoreRecallFeedbackRepository(store);
    await Promise.all([
      store.doc('conversations', conversationId).set({
        id: conversationId,
        agentId,
        channel: 'chat',
      }),
      store.doc('conversations', foreignConversationId).set({
        id: foreignConversationId,
        agentId: randomUUID(),
        channel: 'chat',
      }),
    ]);
  });

  afterEach(async () => disposeStore(store));

  async function message(
    input: { role?: string; conversation?: string; sources?: number | null } = {},
  ): Promise<string> {
    const id = randomUUID();
    const sources = input.sources === undefined ? 2 : input.sources;
    const parts: unknown[] = [{ type: 'text', text: 'From what you told me earlier…' }];
    if (sources !== null)
      parts.push({
        type: 'recall',
        sources: Array.from({ length: sources }, (_, index) => ({ label: `Source ${index}` })),
      });
    await store.doc('messages', id).set(
      encodeRecord({
        id,
        conversationId: input.conversation ?? conversationId,
        role: input.role ?? 'assistant',
        parts,
        createdAt: new Date('2026-09-23T11:00:00.000Z'),
      }),
    );
    return id;
  }

  async function feedbackRows() {
    const snapshot = await store.collection('recallFeedback').get();
    return snapshot.docs.map((doc) => doc.data());
  }

  it('records one revisable verdict per recalled reply without storing recalled text', async () => {
    const messageId = await message();
    await expect(repository.record(agentId, messageId, 'helpful')).resolves.toBe(true);
    await expect(repository.record(agentId, messageId, 'not_helpful')).resolves.toBe(true);

    const rows = await feedbackRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentId, messageId, verdict: 'not_helpful', sourceCount: 2 });
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
      ['agentId', 'createdAt', 'id', 'messageId', 'sourceCount', 'verdict'].sort(),
    );
  });

  it('revises an imported PostgreSQL row instead of adding a second verdict', async () => {
    const messageId = await message();
    const importedId = randomUUID();
    await store.doc('recallFeedback', importedId).set({
      id: importedId,
      agentId,
      messageId,
      verdict: 'helpful',
      sourceCount: 2,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    });

    await expect(repository.record(agentId, messageId, 'not_helpful')).resolves.toBe(true);
    const rows = await feedbackRows();
    expect(rows).toEqual([expect.objectContaining({ id: importedId, verdict: 'not_helpful' })]);
  });

  it('refuses replies that used no recall, user messages, foreign chats, and missing ids', async () => {
    const plain = await message({ sources: null });
    const empty = await message({ sources: 0 });
    const user = await message({ role: 'user' });
    const foreign = await message({ conversation: foreignConversationId });

    for (const id of [plain, empty, user, foreign, randomUUID()])
      await expect(repository.record(agentId, id, 'helpful')).resolves.toBe(false);
    expect(await feedbackRows()).toEqual([]);
  });

  it('keeps concurrent first ratings to a single row', async () => {
    const messageId = await message();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        repository.record(agentId, messageId, index % 2 ? 'helpful' : 'not_helpful'),
      ),
    );
    expect(results).toEqual([true, true, true, true, true]);
    expect(await feedbackRows()).toHaveLength(1);
  });

  it('does not write while privacy erasure is in progress', async () => {
    const messageId = await message();
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'running' });
    await expect(repository.record(agentId, messageId, 'helpful')).rejects.toThrow(
      'Privacy erasure is in progress',
    );
    expect(await feedbackRows()).toEqual([]);
  });
});
