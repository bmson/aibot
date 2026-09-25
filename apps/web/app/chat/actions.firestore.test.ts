import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '@/lib/server';
import { recordRecallFeedbackAction } from './actions';

const auth = vi.hoisted(() => ({ authed: vi.fn() }));
vi.mock('@/auth', () => ({ isAuthed: auth.authed }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore web recall feedback with PostgreSQL offline', () => {
  const installationId = `web-recall-feedback-${randomUUID()}`;
  const agentId = randomUUID();
  const conversationId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });

  beforeAll(() => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_DATABASE_ID', '(default)');
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"vertex","model":"fixture","dimensions":1536,"revision":"1"}',
    );
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    // The chat composition builds (but never calls) the configured model provider.
    vi.stubEnv('VERTEX_PROJECT', 'demo-assistant-test');
    vi.stubEnv('VERTEX_LOCATION', 'us-central1');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    resetConfigForTest();
  });

  beforeEach(async () => {
    auth.authed.mockResolvedValue(true);
    await store.db.recursiveDelete(store.root);
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId, name: 'Assistant', timezone: 'UTC' }),
      store.doc('conversations', conversationId).set({ id: conversationId, agentId }),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  async function recalledReply(): Promise<string> {
    const id = randomUUID();
    await store.doc('messages', id).set({
      id,
      conversationId,
      role: 'assistant',
      parts: [
        { type: 'text', text: 'You mentioned this last week.' },
        { type: 'recall', sources: [{ label: 'Earlier chat' }] },
      ],
      createdAt: new Date(),
    });
    return id;
  }

  it('stores the verdict in Firestore without touching PostgreSQL', async () => {
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
    const messageId = await recalledReply();
    await recordRecallFeedbackAction(messageId, 'helpful');
    await recordRecallFeedbackAction(messageId, 'not_helpful');
    const rows = await store.collection('recallFeedback').get();
    expect(rows.docs.map((doc) => doc.data())).toEqual([
      expect.objectContaining({ agentId, messageId, verdict: 'not_helpful', sourceCount: 1 }),
    ]);
  });

  it('rejects replies without recall and unauthenticated callers', async () => {
    const plain = randomUUID();
    await store.doc('messages', plain).set({
      id: plain,
      conversationId,
      role: 'assistant',
      parts: [{ type: 'text', text: 'No recall here.' }],
      createdAt: new Date(),
    });
    await expect(recordRecallFeedbackAction(plain, 'helpful')).rejects.toThrow(
      'Recall feedback is only available for recalled replies.',
    );

    auth.authed.mockResolvedValueOnce(false);
    await expect(recordRecallFeedbackAction(await recalledReply(), 'helpful')).rejects.toThrow(
      'unauthorized',
    );
    expect((await store.collection('recallFeedback').get()).size).toBe(0);
  });
});
