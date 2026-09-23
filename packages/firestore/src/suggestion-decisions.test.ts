import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallationStore } from './store.js';
import { FirestoreSuggestionDecisionRepository } from './suggestion-decisions.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore suggestion decisions', () => {
  let store: InstallationStore;
  let decisions: FirestoreSuggestionDecisionRepository;
  const agentId = randomUUID();
  const now = new Date('2026-09-23T12:00:00.000Z');

  beforeEach(async () => {
    store = emulatorStore(() => now);
    decisions = new FirestoreSuggestionDecisionRepository(store, agentId);
    await store.doc('agents', agentId).set({ id: agentId });
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  async function seed(
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; conversationId: string }> {
    const id = randomUUID();
    const conversationId = randomUUID();
    await Promise.all([
      store.doc('conversations', conversationId).set({
        id: conversationId,
        agentId,
        channel: 'chat',
        isPrimary: true,
        archivedAt: null,
      }),
      store.doc('suggestions', id).set({
        id,
        agentId,
        conversationId,
        origin: 'watch',
        proposedAction: 'Review the source and ask before sharing anything.',
        status: 'pending',
        expiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        snoozedUntil: null,
        acceptedTaskId: null,
        ...overrides,
      }),
    ]);
    return { id, conversationId };
  }

  it('accepts once into tainted owner work with one durable wake intent', async () => {
    const { id, conversationId } = await seed();
    const [first, second] = await Promise.all([
      decisions.decide(id, 'accepted'),
      decisions.decide(id, 'accepted'),
    ]);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    expect((await store.collection('tasks').get()).size).toBe(1);
    const task = await store.doc('tasks', first.taskId as string).get();
    expect(task.get('agentId')).toBe(agentId);
    expect(task.get('conversationId')).toBe(conversationId);
    expect(task.get('trust')).toBe('owner');
    expect(task.get('trigger.payload.taintedOrigin')).toBe(true);
    expect(task.get('trigger.payload.suggestionId')).toBe(id);
    expect((await store.collection('taskEventKeys').get()).size).toBe(1);
    expect((await store.collection('outbox').get()).size).toBe(1);
  });

  it('keeps foreign, expired, and erased suggestions from creating work', async () => {
    const foreign = await seed({ agentId: randomUUID() });
    expect(await decisions.decide(foreign.id, 'accepted')).toMatchObject({ ok: false });
    const expired = await seed({ expiresAt: new Date(now.getTime() - 1) });
    expect(await decisions.decide(expired.id, 'accepted')).toMatchObject({ ok: false });
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    const current = await seed();
    await expect(decisions.decide(current.id, 'accepted')).rejects.toThrow('Privacy erasure');
    expect((await store.collection('tasks').get()).size).toBe(0);
  });

  it('dismisses idempotently and wakes snoozed cards at a future time', async () => {
    const dismissed = await seed();
    expect(await decisions.decide(dismissed.id, 'dismissed')).toEqual({ ok: true });
    expect(await decisions.decide(dismissed.id, 'dismissed')).toEqual({ ok: true });
    const later = await seed();
    const snoozed = await decisions.decide(later.id, 'snoozed');
    expect(snoozed.snoozedUntil).toBe(new Date(now.getTime() + 24 * 3600 * 1000).toISOString());
    expect(await decisions.decide(later.id, 'snoozed')).toEqual(snoozed);
    expect((await store.doc('suggestions', later.id).get()).get('status')).toBe('snoozed');
    expect((await store.collection('tasks').get()).size).toBe(0);
  });

  it('rejects a foreign conversation and does not launder an outward action', async () => {
    const { id, conversationId } = await seed();
    await store.doc('conversations', conversationId).update({ agentId: randomUUID() });
    await expect(decisions.decide(id, 'accepted')).rejects.toThrow('conversation');
    expect((await store.collection('tasks').get()).size).toBe(0);
    expect((await store.doc('suggestions', id).get()).get('status')).toBe('pending');
  });

  it('uses the owner primary chat when an imported suggestion has no conversation link', async () => {
    const { id, conversationId } = await seed({ conversationId: null });
    const result = await decisions.decide(id, 'accepted');
    expect(result.ok).toBe(true);
    expect((await store.doc('tasks', result.taskId as string).get()).get('conversationId')).toBe(
      conversationId,
    );
    expect((await store.doc('primaryConversations', agentId).get()).get('conversationId')).toBe(
      conversationId,
    );
  });

  it('requires an immediate decision for a dated briefing near its deadline', async () => {
    const { id } = await seed({
      origin: 'briefing',
      proposedAction: 'Set a reminder two days before 2026-09-26 about: a flight',
      expiresAt: new Date('2026-09-30T00:00:00.000Z'),
    });
    expect(await decisions.decide(id, 'snoozed')).toEqual({
      ok: false,
      reason: 'This suggestion needs a decision sooner. Please accept or dismiss it now.',
    });
    expect((await store.doc('suggestions', id).get()).get('status')).toBe('pending');
  });
});
