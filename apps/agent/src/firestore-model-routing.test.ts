import { type ModelProvider, ModelRouter } from '@assistant/core/model-router';
import { FirestoreModelRoutingRepository } from '@assistant/firestore';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import {
  disposeStore,
  emulatorStore,
  seedBudget,
} from '../../../packages/firestore/src/test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore model router composition', () => {
  let store: InstallationStore;
  let repository: FirestoreModelRoutingRepository;
  let model: MockLanguageModelV3;
  let router: ModelRouter;
  beforeEach(async () => {
    store = emulatorStore();
    repository = new FirestoreModelRoutingRepository(store, 'owner');
    await seedBudget(store, 10, 100);
    const now = new Date();
    await store.doc('models', 'test/model').set({
      id: 'test/model',
      label: 'Fake model',
      enabled: true,
      capabilities: {},
      promptCostPerMTok: '1',
      completionCostPerMTok: '2',
      latencyClass: 'fast',
      createdAt: now,
      updatedAt: now,
    });
    await store.doc('modelRoles', 'draft').set({
      role: 'draft',
      primaryModel: 'test/model',
      fallbackModel: 'test/model',
      params: {},
      updatedAt: now,
    });
    await store.doc('tasks', 'task').set({
      id: 'task',
      agentId: 'owner',
      type: 'chat_turn',
      conversationId: 'chat',
      budgetUsdLimit: '5',
      spentUsd: '0',
    });
    await store
      .doc('conversations', 'chat')
      .set({ id: 'chat', agentId: 'owner', modelOverride: null });
    model = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: 'text', text: 'Synthetic response' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      },
    });
    const provider: ModelProvider = {
      kind: 'vertex',
      assertModelId: vi.fn(),
      chat: () => model as unknown as LanguageModel,
      textEmbeddingModel: () => {
        throw new Error('Not an embedding test');
      },
      optionsFor: () => undefined,
      embeddingOptions: () => undefined,
      cacheHint: () => undefined,
      normalizeUsage: () => ({ inputTokens: 10, outputTokens: 5 }),
    };
    router = new ModelRouter(repository, '', 'off', provider);
  });
  afterEach(async () => {
    await disposeStore(store);
  });

  it('routes and meters a fake provider through real Firestore without PostgreSQL', async () => {
    const outcome = await router.generate('draft', { taskId: 'task', prompt: 'Synthetic input' });
    expect(outcome.ok).toBe(true);
    expect(model.doGenerateCalls).toHaveLength(1);
    const calls = await store.collection('modelCalls').get();
    expect(calls.size).toBe(1);
    expect(calls.docs[0]?.data()).toMatchObject({
      taskId: 'task',
      model: 'test/model',
      costUsd: '0.000020',
      openrouterGenerationId: null,
    });
    expect(await repository.costs.totals()).toMatchObject({ heldUsd: 0, dailySpentUsd: 0.00002 });
    expect((await store.collection('modelCallAudit').get()).empty).toBe(true);
  });

  it('rejects foreign tasks and conversation links before any paid provider call', async () => {
    await store.doc('tasks', 'task').update({ agentId: 'another-owner' });
    await expect(router.generate('draft', { taskId: 'task', prompt: 'test' })).rejects.toThrow(
      'owner scope',
    );
    await expect(router.embed(['test'], { taskId: 'task' })).rejects.toThrow('owner scope');
    await store.doc('tasks', 'task').update({ agentId: 'owner' });
    await store.doc('conversations', 'chat').update({ agentId: 'another-owner' });
    await expect(router.generate('draft', { taskId: 'task', prompt: 'test' })).rejects.toThrow(
      'owner scope',
    );
    expect(model.doGenerateCalls).toHaveLength(0);
    expect((await store.collection('costReservations').get()).empty).toBe(true);
  });

  it('uses encoded provider IDs and refuses corrupted role/model identities', async () => {
    expect((await repository.model('test/model'))?.id).toBe('test/model');
    await store.doc('modelRoles', 'draft').update({ role: 'reason' });
    await expect(router.route('draft')).rejects.toThrow('identity mismatch');
    await store.doc('modelRoles', 'draft').update({ role: 'draft' });
    await store.doc('models', 'test/model').update({ id: 'other/model' });
    await expect(router.route('draft')).rejects.toThrow('identity mismatch');
  });

  it('validates audit linkage and preserves nullable fields for background calls', async () => {
    const callId = await repository.recordCall({
      role: 'draft',
      model: 'test/model',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: '0.000003',
      taskId: undefined,
    });
    const audit = {
      modelCallId: callId,
      role: 'draft',
      model: 'test/model',
      method: 'generate',
      capture: 'redacted',
      systemPrompt: null,
      input: null,
      output: null,
      truncated: false,
      inputTokens: 1,
      outputTokens: 1,
    };
    await repository.recordAudit(audit);
    expect((await store.doc('modelCalls', callId).get()).data()).toMatchObject({
      taskId: null,
      finishReason: null,
    });
    await expect(repository.recordAudit({ ...audit, taskId: 'task' })).rejects.toThrow(
      'does not match',
    );
    expect((await store.collection('modelCallAudit').get()).size).toBe(1);
  });
});
