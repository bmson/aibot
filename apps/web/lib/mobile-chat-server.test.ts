import { randomUUID } from 'node:crypto';
import { createInstallationStore, FirestoreApplicationChatPersistence } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ mobile: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.mobile,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore mobile chat routes with PostgreSQL offline', () => {
  const installationId = `mobile-chat-${randomUUID()}`;
  const agentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  const chat = new FirestoreApplicationChatPersistence(store, agentId);
  const base = 'http://localhost/api/mobile/v1/chats';
  const post = (url: string, body: unknown) =>
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const messageParams = (id: string, messageId: string) => ({
    params: Promise.resolve({ id, messageId }),
  });

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://assistant:assistant@127.0.0.1:1/offline_test');
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"openai","model":"text-embedding-3-small","dimensions":1536,"revision":"1"}',
    );
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    auth.mobile.mockResolvedValue(true);
    const now = new Date();
    await store.doc('agents', agentId).set({
      id: agentId,
      name: 'Assistant',
      timezone: 'UTC',
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
  });

  it('allows only the supported mobile chat methods through the Firestore proxy', async () => {
    const { proxy } = await import('../proxy.js');
    const status = (path: string, method = 'GET') =>
      proxy(new NextRequest(`http://localhost${path}`, { method })).status;
    const id = randomUUID();
    const messageId = randomUUID();
    expect(status('/api/mobile/v1/bootstrap')).toBe(503);
    expect(status('/api/mobile/v1/chats')).toBe(503);
    expect(status('/api/mobile/v1/chats', 'POST')).toBe(200);
    expect(status(`/api/mobile/v1/chats/${id}`)).toBe(200);
    expect(status(`/api/mobile/v1/chats/${id}`, 'POST')).toBe(200);
    expect(status(`/api/mobile/v1/chats/${id}`, 'DELETE')).toBe(503);
    expect(status(`/api/mobile/v1/chats/${id}/messages/${messageId}`, 'POST')).toBe(200);
    expect(status(`/api/mobile/v1/chats/${id}/messages/${messageId}`)).toBe(503);
    expect(status('/api/mobile/v1/chats/not-a-uuid', 'POST')).toBe(503);
    expect(status('/api/mobile/v1/workspace')).toBe(503);
  });

  it('creates, reads, changes, archives, restores, and hides owned chat messages without SQL', async () => {
    const collection = await import('../app/api/mobile/v1/chats/route.js');
    const conversation = await import('../app/api/mobile/v1/chats/[id]/route.js');
    const visibility = await import(
      '../app/api/mobile/v1/chats/[id]/messages/[messageId]/route.js'
    );
    const { getDb, getChatApplication } = await import('./server.js');
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');

    auth.mobile.mockResolvedValueOnce(false);
    expect((await collection.POST(post(base, { action: 'create' }))).status).toBe(401);

    const created = await collection.POST(post(base, { action: 'create' }));
    expect(created.status).toBe(201);
    const { conversationId: id } = (await created.json()) as { conversationId: string };
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const fetched = await conversation.GET(new Request(`${base}/${id}`), params(id));
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({ conversation: { id } });

    const model = await conversation.POST(
      post(`${base}/${id}`, { action: 'change-model', modelId: 'openai/gpt-4o-mini' }),
      params(id),
    );
    expect(model.status).toBe(200);
    expect((await chat.getConversation(agentId, id))?.modelOverride).toBe('openai/gpt-4o-mini');

    const message = await chat.appendOwned(agentId, {
      conversationId: id,
      role: 'user',
      origin: 'owner',
      parts: [{ type: 'text', text: 'private detail' }],
      text: 'private detail',
    });
    if (!message) throw new Error('message was not persisted');
    const messageUrl = `${base}/${id}/messages/${message.id}`;
    const hide = await visibility.POST(
      post(messageUrl, { action: 'hide' }),
      messageParams(id, message.id),
    );
    expect(hide.status).toBe(200);
    expect((await chat.listMessages(agentId, id))?.messages).toEqual([]);
    const unhide = await visibility.POST(
      post(messageUrl, { action: 'unhide' }),
      messageParams(id, message.id),
    );
    expect(unhide.status).toBe(200);
    expect((await chat.listMessages(agentId, id))?.messages).toMatchObject([{ id: message.id }]);

    const archived = await conversation.POST(
      post(`${base}/${id}`, { action: 'archive' }),
      params(id),
    );
    expect(archived.status).toBe(200);
    expect((await chat.getConversation(agentId, id))?.archivedAt).toBeInstanceOf(Date);
    const restored = await conversation.POST(
      post(`${base}/${id}`, { action: 'restore' }),
      params(id),
    );
    expect(restored.status).toBe(200);
    expect((await chat.getConversation(agentId, id))?.archivedAt).toBeNull();
    expect(await getChatApplication().listChatHistory(false)).toMatchObject({
      conversations: expect.arrayContaining([expect.objectContaining({ id })]),
    });
    expect((await collection.POST(post(base, { action: 'archive-inactive' }))).status).toBe(200);
  }, 30_000);

  it('rejects foreign and missing conversations and messages', async () => {
    const conversation = await import('../app/api/mobile/v1/chats/[id]/route.js');
    const visibility = await import(
      '../app/api/mobile/v1/chats/[id]/messages/[messageId]/route.js'
    );
    const foreignId = randomUUID();
    const missingId = randomUUID();
    expect(
      (await conversation.GET(new Request(`${base}/${missingId}`), params(missingId))).status,
    ).toBe(404);
    await store.doc('conversations', foreignId).set({
      id: foreignId,
      agentId: randomUUID(),
      channel: 'chat',
      title: 'Foreign',
      createdAt: new Date(),
    });
    expect(
      (await conversation.GET(new Request(`${base}/${foreignId}`), params(foreignId))).status,
    ).toBe(404);
    expect(
      (
        await conversation.POST(
          post(`${base}/${foreignId}`, { action: 'change-model', modelId: null }),
          params(foreignId),
        )
      ).status,
    ).toBe(409);
    const foreignMessageId = randomUUID();
    expect(
      (
        await visibility.POST(
          post(`${base}/${foreignId}/messages/${foreignMessageId}`, { action: 'hide' }),
          messageParams(foreignId, foreignMessageId),
        )
      ).status,
    ).toBe(409);
    const ownedId = await chat.createConversation(agentId).then((row) => row.id);
    const missingMessageId = randomUUID();
    expect(
      (
        await visibility.POST(
          post(`${base}/${ownedId}/messages/${missingMessageId}`, { action: 'hide' }),
          messageParams(ownedId, missingMessageId),
        )
      ).status,
    ).toBe(404);
    const primaryId = await chat.getOrCreatePrimaryConversation(agentId).then((row) => row.id);
    expect(
      (
        await conversation.POST(
          post(`${base}/${primaryId}`, { action: 'archive' }),
          params(primaryId),
        )
      ).status,
    ).toBe(409);
  }, 30_000);
});
