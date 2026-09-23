import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { GcsWorkspaceStore, LocalWorkspaceStore, safeRelPath } from './workspace-store.js';

const root = mkdtempSync(path.join(tmpdir(), 'ws-test-'));
const outside = mkdtempSync(path.join(tmpdir(), 'ws-outside-test-'));
const store = new LocalWorkspaceStore(root);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

afterEach(() => vi.unstubAllGlobals());

describe('safeRelPath', () => {
  it('normalizes and accepts nested paths', () => {
    expect(safeRelPath('notes/today.md')).toBe('notes/today.md');
    expect(safeRelPath('/leading/slash.txt')).toBe('leading/slash.txt');
    expect(safeRelPath('a/./b.txt')).toBe('a/b.txt');
  });

  it('rejects traversal', () => {
    expect(() => safeRelPath('../outside')).toThrow(/escapes/);
    expect(() => safeRelPath('a/../../outside')).toThrow(/escapes/);
    expect(() => safeRelPath('..\\windows')).toThrow(/escapes/);
  });
});

describe('LocalWorkspaceStore', () => {
  it('writes, reads, and lists round-trip', async () => {
    await store.write('notes/hello.txt', 'workspace content');
    expect(await store.read('notes/hello.txt')).toBe('workspace content');

    const rootList = await store.list('.');
    expect(rootList).toContainEqual({ name: 'notes', dir: true });
    const notesList = await store.list('notes');
    expect(notesList).toContainEqual({ name: 'hello.txt', dir: false });
  });

  it('round-trips binary attachments without decoding them as text', async () => {
    const attachment = Buffer.from([0, 255, 1, 2, 0, 250]);
    await store.writeBytes('attachments/resume.pdf', attachment, 'application/pdf');
    expect(await store.readBytes('attachments/resume.pdf')).toEqual(attachment);
  });

  it('read of a missing file throws', async () => {
    await expect(store.read('nope.txt')).rejects.toThrow();
  });

  it('blocks reads and writes through a symlink that escapes the root', async () => {
    writeFileSync(path.join(outside, 'secret.txt'), 'outside');
    symlinkSync(outside, path.join(root, 'escape'), 'dir');
    await expect(store.read('escape/secret.txt')).rejects.toThrow(/outside/);
    await expect(store.write('escape/new.txt', 'nope')).rejects.toThrow(/outside/);
  });
});

describe('GcsWorkspaceStore generation fencing', () => {
  it('captures and conditionally deletes only the recorded object generation', async () => {
    const store = new GcsWorkspaceStore('private-bucket', 'install/owner');
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input.toString());
        requests.push({ url, init });
        if (url.hostname === 'metadata.google.internal')
          return new Response(JSON.stringify({ access_token: 'test-token' }), { status: 200 });
        if (init?.method === 'DELETE') return new Response('generation changed', { status: 412 });
        return new Response(JSON.stringify({ generation: '41' }), { status: 200 });
      }),
    );

    const generation = await store.objectGeneration?.('import/uploads/voice.mbox');
    expect(generation).toBe('41');
    await expect(
      store.deleteGeneration?.('import/uploads/voice.mbox', generation as string),
    ).rejects.toThrow('generation-scoped delete failed: 412');
    const deletion = requests.find(({ init }) => init?.method === 'DELETE');
    expect(deletion?.url.searchParams.get('ifGenerationMatch')).toBe('41');
  });

  it('refuses malformed generations before issuing a delete', async () => {
    const store = new GcsWorkspaceStore('private-bucket', 'install/owner');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(store.deleteGeneration?.('import/uploads/voice.mbox', 'latest')).rejects.toThrow(
      'invalid GCS object generation',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
