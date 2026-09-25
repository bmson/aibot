import { createHash, randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore, embeddingSpaceKey } from '@assistant/firestore';
import type { EmbeddingSpace } from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ owner: vi.fn(), mobile: vi.fn() }));
const router = vi.hoisted(() => ({ embed: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: auth.owner }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.mobile,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), unstable_cache: (run: unknown) => run }));
vi.mock('@assistant/core/model-router', () => ({
  ModelRouter: class {
    embed(...args: unknown[]) {
      return router.embed(...args);
    }
  },
  createConfiguredModelProvider: vi.fn(),
}));

import {
  PATCH as correctSource,
  DELETE as forgetSource,
} from '@/app/api/mobile/v1/knowledge/sources/[id]/route';
import {
  PATCH as correctMobileMemory,
  POST as updateMobileMemory,
} from '@/app/api/mobile/v1/memory/[id]/route';
import { GET as mobilePerson } from '@/app/api/mobile/v1/memory/people/[id]/route';
import { POST as createMobileMemory } from '@/app/api/mobile/v1/memory/route';
import { getDb } from '@/lib/server';
import { proxy } from '@/proxy';
import AboutYouPage from './about/page';
import {
  confirmFact,
  correctCommitmentAction,
  correctFact,
  createMemoryAction,
  dismissCommitmentAction,
  forgetFact,
  resolveCommitmentAction,
  setFactProminence,
  snoozeCommitmentAction,
} from './actions';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);
const space: EmbeddingSpace = {
  provider: 'vertex',
  model: 'fixture',
  dimensions: 1536,
  revision: '1',
};
const vector = [1, ...new Array(space.dimensions - 1).fill(0)];

describe.skipIf(!localEmulator)('Firestore owner memory commands with PostgreSQL offline', () => {
  const installationId = `web-memory-${randomUUID()}`;
  const agentId = randomUUID();
  const ownerContactId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });

  beforeAll(() => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_DATABASE_ID', '(default)');
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv('FIRESTORE_EMBEDDING_SPACE', JSON.stringify(space));
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('VERTEX_PROJECT', 'demo-assistant-test');
    vi.stubEnv('VERTEX_LOCATION', 'us-central1');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    resetConfigForTest();
  });

  beforeEach(async () => {
    auth.owner.mockResolvedValue(undefined);
    auth.mobile.mockResolvedValue(true);
    router.embed.mockReset().mockImplementation(async (texts: string[]) => texts.map(() => vector));
    await store.db.recursiveDelete(store.root);
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId, name: 'Assistant', timezone: 'UTC' }),
      store.doc('contacts', ownerContactId).set({
        id: ownerContactId,
        name: 'Ada Owner',
        trust: 'owner',
        relationship: 'self',
        aliases: [],
        createdAt: new Date('2026-09-01T00:00:00Z'),
        updatedAt: new Date('2026-09-01T00:00:00Z'),
      }),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  async function fact(content: string, patch: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    const contentHash = createHash('sha256').update(content).digest('hex');
    await Promise.all([
      store.doc('memories', id).set({
        id,
        agentId,
        createdAt: new Date('2026-09-20T12:00:00Z'),
        expiresAt: null,
        embedding: FieldValue.vector(vector),
        embeddingSpace: embeddingSpaceKey(space),
        retrievalRevision: randomUUID(),
        sourceTaskId: null,
        kind: 'fact',
        confidence: '0.70',
        contentHash,
        goalId: null,
        originTrust: 'owner',
        category: 'knowledge',
        content,
        importance: 3,
        quarantined: false,
        subjectContactId: ownerContactId,
        domain: 'home',
        validFrom: null,
        validUntil: null,
        supersededById: null,
        ownerConfirmed: false,
        pinned: false,
        source: 'owner',
        lastAccessedAt: null,
        lastConsolidatedAt: null,
        ...patch,
      }),
      store.doc('memoryContentHashes', contentHash).set({ memoryId: id }),
    ]);
    return id;
  }

  async function commitment(patch: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    await store.doc('commitments', id).set({
      id,
      agentId,
      kind: 'promise',
      title: 'Send the slides to Grace',
      details: '',
      nextAction: '',
      status: 'open',
      contentHash: randomUUID(),
      dueAt: null,
      snoozedUntil: null,
      createdAt: new Date('2026-09-20T12:00:00Z'),
      updatedAt: new Date('2026-09-20T12:00:00Z'),
      ...patch,
    });
    return id;
  }

  async function memoryDoc(id: string) {
    return (await store.doc('memories', id).get()).data() ?? {};
  }

  it('opens the owner memory routes in the proxy while PostgreSQL stays fenced', () => {
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
    const id = randomUUID();
    const allowed: Array<[string, string]> = [
      ['/profile/about', 'POST'],
      ['/api/mobile/v1/memory', 'POST'],
      [`/api/mobile/v1/memory/${id}`, 'PATCH'],
      [`/api/mobile/v1/memory/${id}`, 'POST'],
      [`/api/mobile/v1/memory/people/${id}`, 'GET'],
      [`/api/mobile/v1/knowledge/sources/${id}`, 'PATCH'],
      [`/api/mobile/v1/knowledge/sources/${id}`, 'DELETE'],
    ];
    for (const [path, method] of allowed)
      expect(proxy(new NextRequest(`http://localhost${path}`, { method })).status).toBe(200);
    // Source impact still reads PostgreSQL projection tables.
    expect(
      proxy(new NextRequest(`http://localhost/api/mobile/v1/knowledge/sources/${id}`)).status,
    ).toBe(503);
  });

  it('renders the interactive About page from Firestore', async () => {
    await fact('Ada lives in Reykjavik', { pinned: true });
    const html = renderToStaticMarkup(await AboutYouPage());
    expect(html).toContain('About Ada Owner');
    expect(html).toContain('Ada lives in Reykjavik');
    expect(html).toContain('/profile/memories');
  });

  it('confirms, corrects, pins, and forgets owner facts from the web', async () => {
    const id = await fact('Ada lives in Reykjavk');
    await confirmFact(id);
    expect((await memoryDoc(id)).ownerConfirmed).toBe(true);

    await expect(correctFact(id, 'Ada lives in Reykjavik')).resolves.toEqual({});
    expect((await memoryDoc(id)).content).toBe('Ada lives in Reykjavik');
    expect(router.embed).toHaveBeenCalledWith(['Ada lives in Reykjavik'], expect.anything());

    await setFactProminence(id, 'always');
    expect((await memoryDoc(id)).pinned).toBe(true);

    await forgetFact(id);
    expect((await store.doc('memories', id).get()).exists).toBe(false);
  });

  it('creates an owner fact and reports duplicates', async () => {
    const input = {
      content: 'Ada prefers window seats',
      domain: 'preferences',
      importance: '4',
      pinned: false,
      subjectContactId: ownerContactId,
    };
    await expect(createMemoryAction(input)).resolves.toEqual({});
    const rows = await store.collection('memories').where('agentId', '==', agentId).get();
    expect(rows.docs.map((doc) => doc.get('content'))).toEqual(['Ada prefers window seats']);
    await expect(createMemoryAction(input)).resolves.toEqual({
      error: 'That fact is already saved.',
    });
  });

  it('resolves, snoozes, corrects, and dismisses open loops', async () => {
    const resolved = await commitment();
    await resolveCommitmentAction(resolved);
    expect((await store.doc('commitments', resolved).get()).get('status')).toBe('resolved');

    const snoozed = await commitment({ title: 'Book the dentist' });
    await snoozeCommitmentAction(snoozed);
    expect((await store.doc('commitments', snoozed).get()).get('status')).toBe('snoozed');

    const corrected = await commitment({ title: 'Call Mom' });
    await correctCommitmentAction(corrected, 'Call Mum on Sunday', '', 'Phone after lunch');
    expect((await store.doc('commitments', corrected).get()).data()).toMatchObject({
      title: 'Call Mum on Sunday',
      nextAction: 'Phone after lunch',
    });

    const dismissed = await commitment({ title: 'Renew passport' });
    await dismissCommitmentAction(dismissed);
    expect((await store.doc('commitments', dismissed).get()).get('status')).toBe('dismissed');
  });

  it('serves the mobile memory commands and person profile from Firestore', async () => {
    const created = await createMobileMemory(
      new Request('http://localhost/api/mobile/v1/memory', {
        method: 'POST',
        body: JSON.stringify({ content: 'Ada runs on Tuesdays', subjectContactId: ownerContactId }),
      }),
    );
    expect(created.status).toBe(201);

    const id = await fact('Ada owns a red bike');
    const params = { params: Promise.resolve({ id }) };
    const corrected = await correctMobileMemory(
      new Request(`http://localhost/api/mobile/v1/memory/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: 'Ada owns a blue bike' }),
      }),
      params,
    );
    expect(corrected.status).toBe(200);
    expect((await memoryDoc(id)).content).toBe('Ada owns a blue bike');
    const confirmed = await updateMobileMemory(
      new Request(`http://localhost/api/mobile/v1/memory/${id}`, {
        method: 'POST',
        body: JSON.stringify({ action: 'confirm' }),
      }),
      params,
    );
    expect(confirmed.status).toBe(200);
    expect((await memoryDoc(id)).ownerConfirmed).toBe(true);

    const source = await fact('Ada studied in Oslo');
    const sourceParams = { params: Promise.resolve({ id: source }) };
    const sourceCorrected = await correctSource(
      new Request(`http://localhost/api/mobile/v1/knowledge/sources/${source}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: 'Ada studied in Bergen' }),
      }),
      sourceParams,
    );
    expect(sourceCorrected.status).toBe(200);
    expect((await memoryDoc(source)).content).toBe('Ada studied in Bergen');
    const sourceForgotten = await forgetSource(
      new Request(`http://localhost/api/mobile/v1/knowledge/sources/${source}`, {
        method: 'DELETE',
      }),
      sourceParams,
    );
    expect(sourceForgotten.status).toBe(200);
    expect((await store.doc('memories', source).get()).exists).toBe(false);

    const friendId = randomUUID();
    await store.doc('contacts', friendId).set({
      id: friendId,
      name: 'Grace Friend',
      trust: 'known',
      relationship: 'friend',
      aliases: [],
      createdAt: new Date('2026-09-01T00:00:00Z'),
      updatedAt: new Date('2026-09-01T00:00:00Z'),
    });
    await fact('Grace plays the cello', { subjectContactId: friendId, originTrust: 'known' });
    const person = await mobilePerson(
      new Request(`http://localhost/api/mobile/v1/memory/people/${friendId}`),
      { params: Promise.resolve({ id: friendId }) },
    );
    expect(person.status).toBe(200);
    const body = (await person.json()) as {
      contact: { name: string };
      facts: Array<{ content: string }>;
    };
    expect(body.contact.name).toBe('Grace Friend');
    expect(body.facts.map((row) => row.content)).toEqual(['Grace plays the cello']);
  });

  it('requires the owner before changing memory', async () => {
    const id = await fact('Ada has a cat');
    auth.owner.mockRejectedValueOnce(new Error('unauthorized'));
    await expect(forgetFact(id)).rejects.toThrow('unauthorized');
    expect((await store.doc('memories', id).get()).exists).toBe(true);
  });
});
