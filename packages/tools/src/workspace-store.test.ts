import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalWorkspaceStore, safeRelPath } from './workspace-store.js';

const root = mkdtempSync(path.join(tmpdir(), 'ws-test-'));
const outside = mkdtempSync(path.join(tmpdir(), 'ws-outside-test-'));
const store = new LocalWorkspaceStore(root);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

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
