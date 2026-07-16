import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalWorkspaceStore, safeRelPath } from './workspace-store.js';

const root = mkdtempSync(path.join(tmpdir(), 'ws-test-'));
const store = new LocalWorkspaceStore(root);

afterAll(() => rmSync(root, { recursive: true, force: true }));

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

  it('read of a missing file throws', async () => {
    await expect(store.read('nope.txt')).rejects.toThrow();
  });
});
