import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type ExecutorDeps, executeTask, type ModelRouter } from '@assistant/core';
import type { Db } from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  embeddingSpaceKey,
  type InstallationStore,
} from '@assistant/firestore';
import type { EmbeddingSpace } from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';

export const CHAT_SMOKE_SPACE: EmbeddingSpace = {
  provider: 'synthetic',
  model: 'chat-fixture',
  dimensions: 1536,
  revision: '1',
};

/** Full queued chat -> planner -> model -> durable final, with synthetic provider output. */
export async function firestoreChatSmoke(store: InstallationStore) {
  const agentId = randomUUID();
  const conversationId = randomUUID();
  const skillId = randomUUID();
  const persistence = createFirestoreExecutionPersistence(store, agentId, CHAT_SMOKE_SPACE);
  const now = new Date();
  const request = 'Explain how a rainbow forms.';
  const answer =
    'A rainbow appears when sunlight is refracted and reflected inside water droplets.';
  const embedding = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
  await store.doc('agents', agentId).set({
    id: agentId,
    name: 'Synthetic assistant',
    email: 'assistant@example.invalid',
    signature: '',
    timezone: 'UTC',
    locale: 'en',
    workspacePrefix: 'synthetic',
    credentialRefs: {},
    createdAt: now,
    updatedAt: now,
  });
  await store.doc('conversations', conversationId).set({
    id: conversationId,
    agentId,
    channel: 'chat',
    trust: 'owner',
    createdAt: now,
    updatedAt: now,
  });
  await store.doc('ownerCards', agentId).set({
    agentId,
    content: 'Synthetic owner prefers clear explanations.',
    compiledAt: now,
  });
  await store.doc('locationPings', `${agentId}-location`).set({
    id: `${agentId}-location`,
    agentId,
    lat: '37.7',
    lng: '-122.4',
    label: 'Synthetic Observatory',
    accuracyM: 10,
    source: 'test',
    timeZone: 'UTC',
    capturedAt: now,
    createdAt: now,
  });
  assert.equal(
    (
      await persistence.ownerContext.getLatestLocation({
        agentId,
        notBefore: new Date(now.getTime() - 60_000),
        notAfter: now,
        source: 'test',
      })
    )?.id,
    `${agentId}-location`,
  );
  await store.doc('commitments', `${agentId}-commitment`).set({
    id: `${agentId}-commitment`,
    agentId,
    kind: 'follow_up',
    title: 'Rainbow observation notes',
    nextAction: 'Compare the rainbow notes',
    status: 'open',
    snoozedUntil: null,
    dueAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await store.doc('skills', skillId).set({
    id: skillId,
    agentId,
    name: 'Explain science clearly',
    preconditions: 'Conceptual science questions',
    steps: 'Start with the physical process.',
    gotchas: 'Avoid unsupported claims.',
    embedding: FieldValue.vector(embedding),
    embeddingSpace: embeddingSpaceKey(CHAT_SMOKE_SPACE),
    deprecated: false,
    useCount: 0,
    successCount: 0,
    failureCount: 0,
    ownerAuthored: true,
    originTrust: 'owner',
    sourceTaskId: null,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  const { task } = await persistence.tasks.createTask({
    agentId,
    conversationId,
    type: 'chat_turn',
    trust: 'owner',
    trigger: { source: 'chat', payload: { text: request } },
  });
  const sqlAccesses: string[] = [];
  const unavailableDb = new Proxy(
    {},
    {
      get: (_target, property) => {
        sqlAccesses.push(String(property));
        throw new Error(`Unexpected SQL access: ${String(property)}`);
      },
    },
  );
  const roles: string[] = [];
  let systemPrompt = '';
  let delivered = 0;
  const router = {
    async object(role: string) {
      roles.push(role);
      const object =
        role === 'classify'
          ? { trivial: false }
          : role === 'plan'
            ? {
                action: 'reply',
                reasoning: 'Explain the natural phenomenon',
                steps: [],
                missingInfo: [],
              }
            : { decision: 'publish', reasons: [] };
      return { ok: true, object, modelId: 'synthetic/model', degraded: false };
    },
    async embed() {
      return [embedding];
    },
    async step(_role: string, input: { system: string }) {
      systemPrompt = input.system;
      return {
        ok: true,
        modelId: 'synthetic/model',
        degraded: false,
        text: answer,
        toolCalls: [],
        finishReason: 'stop',
      };
    },
  } as unknown as ModelRouter;
  const deps: ExecutorDeps = {
    db: unavailableDb as Db,
    router,
    persistence,
    dispatcher: {
      toolDefs: () => [],
      resultIsUntrusted: () => false,
      dispatch: async () => {
        throw new Error('Unexpected tool dispatch');
      },
      executeApproved: async () => {
        throw new Error('Unexpected approval');
      },
    },
    deliverFinal: async () => {
      delivered++;
    },
  };
  const outcome = await executeTask(deps, task.id);
  assert.deepEqual(sqlAccesses, [], 'Even best-effort context must avoid SQL');
  assert.equal(outcome.outcome, 'done', JSON.stringify(outcome));
  assert.equal(delivered, 1);
  assert.deepEqual(roles.slice(0, 2), ['classify', 'plan']);
  assert.match(systemPrompt, /Synthetic owner prefers clear explanations/);
  assert.match(systemPrompt, /Synthetic Observatory/);
  assert.match(systemPrompt, /Rainbow observation notes/);
  assert.match(systemPrompt, /Explain science clearly/);
  assert.equal((await store.doc('tasks', task.id).get()).get('plan.action'), 'reply');
  assert.equal((await store.doc('skills', skillId).get()).get('useCount'), 1);
  assert.equal((await store.doc('skills', skillId).get()).get('successCount'), 1);
  assert.equal(
    await persistence.executionEvidence.finalMessageExists({
      agentId,
      conversationId,
      taskId: task.id,
      text: answer,
    }),
    true,
  );
  assert.equal((await executeTask(deps, task.id)).outcome, 'not_claimable');
  assert.equal(delivered, 1);
  return {
    planned: true,
    ownerContext: true,
    skills: true,
    finalized: true,
    sqlAccesses: sqlAccesses.length,
  };
}
