import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FirestoreCardRefreshRepository } from './card-refresh.js';
import { disposeStore, emulatorStore } from './test-store.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

function deterministicPrimaryId(agentId: string): string {
  const hex = createHash('sha256')
    .update(`assistant:primary-conversation:${agentId}`)
    .digest('hex');
  const value = `${hex.slice(0, 12)}5${hex.slice(13, 16)}8${hex.slice(17, 32)}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(
    16,
    20,
  )}-${value.slice(20)}`;
}

describe.skipIf(!enabled)('Firestore saved-card refresh', () => {
  it('deduplicates concurrent owner refreshes into one task and outbox wake', async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    const cardId = randomUUID();
    const revisionId = randomUUID();
    const conversationId = randomUUID();
    try {
      await Promise.all([
        store.doc('conversations', conversationId).set({
          id: conversationId,
          agentId,
          channel: 'chat',
          isPrimary: true,
        }),
        store.doc('generatedCardRevisions', revisionId).set({
          id: revisionId,
          cardId,
          spec: { version: 1 },
        }),
        store.doc('generatedCards', cardId).set({
          id: cardId,
          agentId,
          conversationId,
          currentRevisionId: revisionId,
          status: 'active',
          dismissedAt: null,
        }),
      ]);
      const repository = new FirestoreCardRefreshRepository(store);
      const request = () =>
        repository.request({
          agentId,
          cardId,
          conversationId,
          formatInstruction: () => ({ title: 'Refresh card', instruction: 'Read only.' }),
        });
      const results = await Promise.all(Array.from({ length: 8 }, request));
      expect(
        new Set(results.flatMap((result) => (result.ok ? [result.taskId] : [])).values()).size,
      ).toBe(1);
      expect(results.filter((result) => result.ok && result.created)).toHaveLength(1);
      expect((await store.collection('tasks').get()).size).toBe(1);
      expect((await store.collection('outbox').get()).size).toBe(1);
    } finally {
      await disposeStore(store);
    }
  });

  it('does not reveal or refresh another owner card', async () => {
    const store = emulatorStore();
    const ownerId = randomUUID();
    const cardId = randomUUID();
    const revisionId = randomUUID();
    try {
      await store.doc('generatedCards', cardId).set({
        id: cardId,
        agentId: ownerId,
        conversationId: null,
        currentRevisionId: revisionId,
        status: 'active',
        dismissedAt: null,
      });
      const result = await new FirestoreCardRefreshRepository(store).request({
        agentId: randomUUID(),
        cardId,
        formatInstruction: () => ({ title: 'Refresh card', instruction: 'Read only.' }),
      });
      expect(result).toEqual({ ok: false, error: 'Card not found.', status: 404 });
      expect((await store.collection('tasks').get()).empty).toBe(true);
      expect((await store.collection('outbox').get()).empty).toBe(true);
    } finally {
      await disposeStore(store);
    }
  });

  it('finds an older active imported refresh behind a newer completed task', async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    const cardId = randomUUID();
    const revisionId = randomUUID();
    const conversationId = randomUUID();
    const activeTaskId = randomUUID();
    const doneTaskId = randomUUID();
    try {
      await Promise.all([
        store.doc('conversations', conversationId).set({
          id: conversationId,
          agentId,
          channel: 'chat',
          trust: 'owner',
          isPrimary: true,
        }),
        store.doc('generatedCardRevisions', revisionId).set({ id: revisionId, cardId, spec: {} }),
        store.doc('generatedCards', cardId).set({
          id: cardId,
          agentId,
          conversationId,
          currentRevisionId: revisionId,
          status: 'active',
          dismissedAt: null,
        }),
        store.doc('tasks', activeTaskId).set({
          id: activeTaskId,
          agentId,
          status: 'pending',
          queueGeneration: 0,
          trigger: { payload: { refreshCardId: cardId } },
          createdAt: new Date('2026-09-18T00:00:00Z'),
        }),
        store.doc('tasks', doneTaskId).set({
          id: doneTaskId,
          agentId,
          status: 'done',
          queueGeneration: 0,
          trigger: { payload: { refreshCardId: cardId } },
          createdAt: new Date('2026-09-19T00:00:00Z'),
        }),
      ]);
      const result = await new FirestoreCardRefreshRepository(store).request({
        agentId,
        cardId,
        conversationId,
        formatInstruction: () => ({ title: 'Refresh card', instruction: 'Read only.' }),
      });
      expect(result).toMatchObject({ ok: true, taskId: activeTaskId, created: false });
      expect((await store.collection('outbox').get()).empty).toBe(true);
    } finally {
      await disposeStore(store);
    }
  });

  it('restores an archived primary conversation used as the fallback destination', async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    const cardId = randomUUID();
    const revisionId = randomUUID();
    const conversationId = randomUUID();
    try {
      await Promise.all([
        store.doc('conversations', conversationId).set({
          id: conversationId,
          agentId,
          channel: 'chat',
          trust: 'owner',
          isPrimary: true,
          archived: true,
          archivedAt: new Date('2026-09-01T00:00:00Z'),
        }),
        store.doc('generatedCardRevisions', revisionId).set({ id: revisionId, cardId, spec: {} }),
        store.doc('generatedCards', cardId).set({
          id: cardId,
          agentId,
          conversationId: null,
          currentRevisionId: revisionId,
          status: 'active',
          dismissedAt: null,
        }),
      ]);

      const result = await new FirestoreCardRefreshRepository(store).request({
        agentId,
        cardId,
        formatInstruction: () => ({ title: 'Refresh card', instruction: 'Read only.' }),
      });
      expect(result).toMatchObject({ ok: true, created: true });
      const primary = await store.doc('conversations', conversationId).get();
      expect(primary.get('archivedAt')).toBeNull();
      expect(primary.get('archived')).toBe(false);
      if (!result.ok) throw new Error('refresh failed');
      expect((await store.doc('tasks', result.taskId).get()).get('conversationId')).toBe(
        conversationId,
      );
    } finally {
      await disposeStore(store);
    }
  });

  it('refuses to overwrite a foreign deterministic primary conversation', async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    const cardId = randomUUID();
    const revisionId = randomUUID();
    const primaryId = deterministicPrimaryId(agentId);
    try {
      await Promise.all([
        store.doc('generatedCardRevisions', revisionId).set({ id: revisionId, cardId, spec: {} }),
        store.doc('generatedCards', cardId).set({
          id: cardId,
          agentId,
          conversationId: null,
          currentRevisionId: revisionId,
          status: 'active',
          dismissedAt: null,
        }),
        store.doc('conversations', primaryId).set({
          id: primaryId,
          agentId: randomUUID(),
          channel: 'email',
          trust: 'unknown',
          isPrimary: false,
        }),
      ]);
      await expect(
        new FirestoreCardRefreshRepository(store).request({
          agentId,
          cardId,
          formatInstruction: () => ({ title: 'Refresh card', instruction: 'Read only.' }),
        }),
      ).rejects.toThrow('identity collision');
      expect((await store.doc('conversations', primaryId).get()).get('channel')).toBe('email');
      expect((await store.collection('tasks').get()).empty).toBe(true);
      expect((await store.collection('outbox').get()).empty).toBe(true);
    } finally {
      await disposeStore(store);
    }
  });
});
