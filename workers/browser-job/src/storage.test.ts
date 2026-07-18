import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildStores } from './storage.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

describe('local browser blob storage', () => {
  it('reads and writes ordinary blobs inside its root', async () => {
    const root = await temporaryDirectory('assistant-browser-store-');
    const store = buildStores({ driver: 'local', root }).workspace;

    await store.put('browser/attachments/resume.pdf', Buffer.from('%PDF'), 'application/pdf');

    await expect(store.get('browser/attachments/resume.pdf')).resolves.toEqual(Buffer.from('%PDF'));
  });

  it('refuses a symlink that points outside the browser workspace', async () => {
    const root = await temporaryDirectory('assistant-browser-store-');
    const outside = await temporaryDirectory('assistant-browser-outside-');
    await writeFile(path.join(outside, 'secret.txt'), 'not an attachment');
    await mkdir(path.join(root, 'browser', 'attachments'), { recursive: true });
    await symlink(
      path.join(outside, 'secret.txt'),
      path.join(root, 'browser', 'attachments', 'resume.pdf'),
    );
    const store = buildStores({ driver: 'local', root }).workspace;

    await expect(store.get('browser/attachments/resume.pdf')).rejects.toThrow(
      /outside the store root/,
    );
  });
});
