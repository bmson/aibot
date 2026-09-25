import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ authed: vi.fn() }));
const workspaceRoot = vi.hoisted(() => ({ dir: '' }));
vi.mock('@/auth', () => ({ isAuthed: auth.authed }));
vi.mock('@assistant/tools/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@assistant/tools/workspace')>();
  return {
    ...actual,
    LocalWorkspaceStore: class extends actual.LocalWorkspaceStore {
      constructor() {
        super(workspaceRoot.dir);
      }
    },
  };
});

import { getDb } from '@/lib/server';
import { proxy } from '@/proxy';
import { GET } from './route';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore artifact download with PostgreSQL offline', () => {
  const installationId = `web-files-${randomUUID()}`;
  const agentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  const artifact = `code/${randomUUID()}/report.csv`;

  beforeAll(async () => {
    workspaceRoot.dir = mkdtempSync(path.join(tmpdir(), 'assistant-files-'));
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
    vi.stubEnv('FILES_DRIVER', 'local');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    resetConfigForTest();
    auth.authed.mockResolvedValue(true);
    mkdirSync(path.join(workspaceRoot.dir, path.dirname(artifact)), { recursive: true });
    writeFileSync(path.join(workspaceRoot.dir, artifact), 'a,b\n1,2\n');
    writeFileSync(path.join(workspaceRoot.dir, 'code/unrecorded.csv'), 'secret');
    const fileId = randomUUID();
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('files', fileId).set({
        id: fileId,
        agentId,
        taskId: null,
        workspacePath: artifact,
        mime: 'text/csv',
        bytes: 8,
        sha256: null,
        createdAt: new Date(),
      }),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    rmSync(workspaceRoot.dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  const download = (workspacePath: string) =>
    GET(new Request(`http://localhost/api/files?path=${encodeURIComponent(workspacePath)}`));

  it('streams a recorded owner artifact without PostgreSQL', async () => {
    expect(() => getDb()).toThrow('PostgreSQL-backed web surface is unavailable');
    expect(proxy(new NextRequest('http://localhost/api/files?path=x')).status).toBe(200);
    const response = await download(artifact);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="report.csv"');
    expect(await response.text()).toBe('a,b\n1,2\n');
  });

  it('refuses unrecorded paths, unsafe prefixes, and unauthenticated callers', async () => {
    expect((await download('code/unrecorded.csv')).status).toBe(404);
    expect((await download('../../etc/passwd')).status).toBe(404);
    auth.authed.mockResolvedValueOnce(false);
    expect((await download(artifact)).status).toBe(401);
  });
});
