import { randomUUID } from 'node:crypto';
import { createInstallationStore, FirestoreTaskRepository } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ web: vi.fn(), mobile: vi.fn(), owner: vi.fn() }));
vi.mock('@/auth', () => ({ isAuthed: auth.web, requireOwner: auth.owner }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.mobile,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore web chat routes with PostgreSQL offline', () => {
  const installationId = `web-chat-${randomUUID()}`;
  const agentId = randomUUID();
  const store = createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId,
  });
  const postBody = (conversationId?: string) => ({
    ...(conversationId ? { conversationId } : {}),
    force: true,
    messages: [{ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Do this task' }] }],
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
    auth.web.mockResolvedValue({ user: { email: 'owner@example.com' } });
    auth.mobile.mockResolvedValue(true);
    auth.owner.mockResolvedValue({ user: { email: 'owner@example.com' } });
    const now = new Date();
    await store.doc('agents', agentId).set({
      id: agentId,
      name: 'Assistant',
      timezone: 'UTC',
      createdAt: now,
      updatedAt: now,
    });
    // A different, older agent must never become this installation's chat owner.
    const otherAgentId = randomUUID();
    await store.doc('agents', otherAgentId).set({
      id: otherAgentId,
      name: 'Other assistant',
      timezone: 'UTC',
      createdAt: new Date(0),
    });
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
  });

  it('authenticates web/mobile routes, persists both turns, and polls their tasks without SQL', async () => {
    const webPost = await import('../app/api/chat/route.js');
    const webStatus = await import('../app/api/chat/status/route.js');
    const mobilePost = await import('../app/api/mobile/v1/chat/route.js');
    const mobileStatus = await import('../app/api/mobile/v1/chat/status/route.js');
    const { getDb } = await import('./server.js');
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');

    auth.web.mockResolvedValueOnce(null);
    expect(
      (await webPost.POST(new Request('http://localhost/api/chat', { method: 'POST' }))).status,
    ).toBe(401);
    auth.mobile.mockResolvedValueOnce(false);
    expect(
      (
        await mobilePost.POST(
          new Request('http://localhost/api/mobile/v1/chat', { method: 'POST' }),
        )
      ).status,
    ).toBe(401);
    auth.web.mockResolvedValueOnce(null);
    expect(
      (
        await webStatus.GET(
          new Request(`http://localhost/api/chat/status?conversationId=${randomUUID()}`),
        )
      ).status,
    ).toBe(401);
    auth.mobile.mockResolvedValueOnce(false);
    expect(
      (
        await mobileStatus.GET(
          new Request(`http://localhost/api/mobile/v1/chat/status?conversationId=${randomUUID()}`),
        )
      ).status,
    ).toBe(401);

    const web = await webPost.POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(postBody()),
      }),
    );
    expect(web.status).toBe(200);
    const conversationId = web.headers.get('x-conversation-id');
    const webTaskId = web.headers.get('x-async-task');
    expect(conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(webTaskId).toMatch(/^[0-9a-f-]{36}$/);

    const mobile = await mobilePost.POST(
      new Request('http://localhost/api/mobile/v1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(postBody(conversationId ?? undefined)),
      }),
    );
    expect(mobile.status).toBe(200);
    const mobileTaskId = mobile.headers.get('x-async-task');
    expect(mobile.headers.get('x-conversation-id')).toBe(conversationId);
    expect(mobileTaskId).toMatch(/^[0-9a-f-]{36}$/);

    const tasks = new FirestoreTaskRepository(store);
    expect((await tasks.getTask(webTaskId as string))?.agentId).toBe(agentId);
    expect((await tasks.getTask(mobileTaskId as string))?.agentId).toBe(agentId);
    const webPoll = await webStatus.GET(
      new Request(
        `http://localhost/api/chat/status?conversationId=${conversationId}&taskId=${webTaskId}`,
      ),
    );
    expect(webPoll.status).toBe(200);
    expect(await webPoll.json()).toMatchObject({ taskStatus: 'pending' });
    const mobilePoll = await mobileStatus.GET(
      new Request(
        `http://localhost/api/mobile/v1/chat/status?conversationId=${conversationId}&taskId=${mobileTaskId}`,
      ),
    );
    expect(mobilePoll.status).toBe(200);
    expect(await mobilePoll.json()).toMatchObject({ taskStatus: 'pending' });

    const foreignConversation = randomUUID();
    await store.doc('conversations', foreignConversation).set({
      id: foreignConversation,
      agentId: randomUUID(),
      channel: 'chat',
      title: 'Foreign',
      createdAt: new Date(),
    });
    expect(
      (
        await webStatus.GET(
          new Request(`http://localhost/api/chat/status?conversationId=${foreignConversation}`),
        )
      ).status,
    ).toBe(404);
  }, 30_000);

  it('closes unsupported web surfaces while leaving chat and auth reachable', async () => {
    const { proxy } = await import('../proxy.js');
    const request = (path: string, method = 'GET') =>
      new NextRequest(`http://localhost${path}`, { method });
    expect(proxy(request('/api/mobile/v1/bootstrap')).status).toBe(503);
    expect(proxy(request('/chat')).status).toBe(200);
    expect(proxy(request(`/chat/${randomUUID()}`)).status).toBe(200);
    expect(proxy(request('/chat/all')).status).toBe(200);
    expect(proxy(request('/tasks')).status).toBe(503);
    expect(proxy(request('/api/mobile/v1/chats', 'POST')).status).toBe(200);
    expect(proxy(request('/api/chat', 'POST')).status).toBe(200);
    expect(proxy(request('/api/mobile/v1/chat/status')).status).toBe(200);
    expect(proxy(request('/api/card-image?url=https%3A%2F%2Fexample.com%2Flogo.png')).status).toBe(
      200,
    );
    expect(proxy(request('/api/card-image', 'POST')).status).toBe(503);
    expect(proxy(request('/api/cards/live')).status).toBe(503);
    expect(proxy(request('/api/maps/route')).status).toBe(503);
    expect(proxy(request('/api/auth/session')).status).toBe(200);
  });

  it('bootstraps and renders the primary chat and history without PostgreSQL', async () => {
    const { getChatApplication, getAgentIdentity } = await import('./server.js');
    const application = getChatApplication();
    const primaryId = await application.getPrimaryConversationId();
    expect(await application.getPrimaryConversationId()).toBe(primaryId);
    expect(await getAgentIdentity()).toMatchObject({ id: agentId, name: 'Assistant' });

    const ChatIndexPage = (await import('../app/chat/page.js')).default;
    const index = await ChatIndexPage({ searchParams: Promise.resolve({}) });
    expect(index.props).toMatchObject({
      conversationId: primaryId,
      isPrimary: true,
      firestorePreview: true,
    });

    const ChatListPage = (await import('../app/chat/all/page.js')).default;
    const history = await ChatListPage({ searchParams: Promise.resolve({}) });
    expect(history).toBeTruthy();
    expect((await application.listChatHistory(false)).conversations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: primaryId, agentId })]),
    );
  }, 30_000);
});
