import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ sqlCalls: vi.fn(), redirects: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: vi.fn().mockResolvedValue({ id: 'owner' }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    state.redirects(url);
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock('@/lib/server', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server')>('@/lib/server');
  return {
    ...actual,
    getDb: () => {
      state.sqlCalls();
      throw new Error('PostgreSQL must be unreachable for Firestore web Goals');
    },
  };
});

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore web Goals with PostgreSQL offline', () => {
  const installationId = `web-goals-${randomUUID()}`;
  const agentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  let actions: typeof import('./actions.js');
  let page: typeof import('./page.js');

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
    await store.doc('agents', agentId).set({ id: agentId, timezone: 'America/Los_Angeles' });
    actions = await import('./actions.js');
    page = await import('./page.js');
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('exposes the page and its actions through the Firestore proxy', async () => {
    const { proxy } = await import('../../proxy.js');
    expect(proxy(new NextRequest('http://localhost/goals')).status).toBe(200);
    expect(proxy(new NextRequest('http://localhost/goals', { method: 'POST' })).status).toBe(200);
  });

  it('creates, renders, edits, and archives a goal without opening SQL', async () => {
    const form = new FormData();
    form.set('title', 'Book a mountain trip');
    form.set('description', 'Travel in October');
    form.set('priority', '2');
    expect(
      await actions.createGoal({ error: null }, form).catch((error: Error) => error.message),
    ).toMatch(/^redirect:\/chat\//);
    expect(state.redirects).toHaveBeenCalledTimes(1);
    const goals = await store.collection('goals').where('agentId', '==', agentId).get();
    expect(goals.size).toBe(1);
    const id = goals.docs[0]?.get('id') as string | undefined;
    expect(id).toBeTruthy();
    if (!id) throw new Error('Created goal is missing');

    const view = await page.default({ searchParams: Promise.resolve({}) });
    const cards: Array<{ title?: string }> = [];
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const props = (node as { props?: { goal?: { title?: string }; children?: unknown } }).props;
      if (props?.goal) cards.push(props.goal);
      if (Array.isArray(props?.children)) props.children.forEach(visit);
      else visit(props?.children);
    };
    visit(view);
    expect(cards).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'Book a mountain trip' })]),
    );

    const update = new FormData();
    update.set('goalId', id);
    update.set('title', 'Book the mountain trip');
    update.set('priority', '2');
    expect(await actions.updateGoal({ error: null }, update)).toEqual({ error: null });
    await actions.setGoalStatus(id, 'paused');
    await actions.setGoalAutonomy(id, true);
    const stored = await store.doc('goals', id).get();
    expect(stored.get('title')).toBe('Book the mountain trip');
    expect(stored.get('status')).toBe('paused');
    expect(stored.get('autonomy')).toBe(true);

    const task = await store.collection('tasks').where('goalId', '==', id).get();
    expect(task.size).toBe(1);
    await task.docs[0]?.ref.update({ status: 'done' });
    expect(await actions.archiveGoal(id).catch((error: Error) => error.message)).toBe(
      'redirect:/goals',
    );
    expect((await store.doc('goals', id).get()).get('archivedAt')).toBeTruthy();
    expect(state.sqlCalls).not.toHaveBeenCalled();
  });
});
