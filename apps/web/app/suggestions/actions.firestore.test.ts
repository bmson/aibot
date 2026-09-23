import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireOwner: vi.fn(), sqlCalls: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: mocks.requireOwner }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/server', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server')>('@/lib/server');
  return {
    ...actual,
    getDb: () => {
      mocks.sqlCalls();
      throw new Error('PostgreSQL must be offline for Firestore suggestion actions');
    },
  };
});

const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(
  process.env.FIRESTORE_EMULATOR_HOST ?? '',
);

describe.skipIf(!localEmulator)('Firestore web suggestion actions with PostgreSQL offline', () => {
  const installationId = `web-suggestions-${randomUUID()}`;
  const agentId = randomUUID();
  const conversationId = randomUUID();
  const acceptId = randomUUID();
  const laterId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  let actions: typeof import('./actions.js');

  beforeAll(async () => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"vertex","model":"fixture","dimensions":768,"revision":"1"}',
    );
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    mocks.requireOwner.mockResolvedValue({});
    actions = await import('./actions.js');
    const suggestion = (id: string) => ({
      id,
      agentId,
      conversationId,
      origin: 'watch',
      proposedAction: 'Review this carefully.',
      status: 'pending',
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      snoozedUntil: null,
      acceptedTaskId: null,
    });
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('conversations', conversationId).set({
        id: conversationId,
        agentId,
        channel: 'chat',
        archivedAt: null,
        isPrimary: true,
      }),
      store.doc('suggestions', acceptId).set(suggestion(acceptId)),
      store.doc('suggestions', laterId).set(suggestion(laterId)),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('answers both web controls without touching PostgreSQL', async () => {
    const accepted = await actions.decideSuggestionInline(acceptId, 'accepted');
    expect(accepted.ok).toBe(true);
    expect(accepted.taskId).toBeTruthy();
    expect(await actions.decideSuggestionInline(acceptId, 'accepted')).toEqual(accepted);
    const snoozed = await actions.snoozeSuggestionInline(laterId);
    expect(snoozed.ok).toBe(true);
    expect(snoozed.snoozedUntil).toBeTruthy();
    expect((await store.collection('tasks').get()).size).toBe(1);
    expect(mocks.sqlCalls).not.toHaveBeenCalled();
  });
});
