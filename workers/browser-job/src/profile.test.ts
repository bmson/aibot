import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseJobInput } from './input.js';
import { assertSafeTarMembers, decryptProfile, encryptProfile } from './profile.js';

const exec = promisify(execFile);

describe('profile encryption', () => {
  const key = randomBytes(32).toString('hex');

  it('round-trips', () => {
    const data = randomBytes(4096);
    const sealed = encryptProfile(data, key);
    expect(sealed.length).toBe(12 + 16 + data.length);
    expect(decryptProfile(sealed, key).equals(data)).toBe(true);
  });

  it('fails closed on a wrong key or tampered payload', () => {
    const sealed = encryptProfile(Buffer.from('cookies'), key);
    expect(() => decryptProfile(sealed, randomBytes(32).toString('hex'))).toThrow();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    expect(() => decryptProfile(tampered, key)).toThrow();
  });

  it('rejects short keys', () => {
    expect(() => encryptProfile(Buffer.from('x'), 'abcd')).toThrow(/32 bytes/);
  });
});

describe('assertSafeTarMembers (path-traversal guard)', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'profile-tar-'));
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('accepts a benign relative-path tarball', async () => {
    await writeFile(path.join(dir, 'cookies'), 'ok');
    const tar = path.join(dir, 'safe.tar.gz');
    await exec('tar', ['-czf', tar, '-C', dir, 'cookies']);
    await expect(assertSafeTarMembers(tar)).resolves.toBeUndefined();
  });

  it('rejects an absolute-path member', async () => {
    await writeFile(path.join(dir, 'evil'), 'x');
    const tar = path.join(dir, 'abs.tar.gz');
    // -P/-absolute-names preserves the leading slash as a member name.
    await exec('tar', ['-czPf', tar, path.join(dir, 'evil')]);
    await expect(assertSafeTarMembers(tar)).rejects.toThrow(/unsafe tar member/);
  });

  it('rejects a symlink escaping the profile dir', async () => {
    const linkDir = await mkdtemp(path.join(tmpdir(), 'profile-link-'));
    try {
      await exec('ln', ['-s', '/etc/passwd', path.join(linkDir, 'leak')]);
      const tar = path.join(dir, 'link.tar.gz');
      await exec('tar', ['-czf', tar, '-C', linkDir, 'leak']);
      await expect(assertSafeTarMembers(tar)).rejects.toThrow(/unsafe tar link target/);
    } finally {
      await rm(linkDir, { recursive: true, force: true });
    }
  });

  it('accepts a benign hardlink to an in-archive relative member (no false positive)', async () => {
    // A real hardlink renders as "<name> link to <target>" — the new marker
    // scan must parse it without flagging a safe relative target. (A hardlink
    // whose target escapes requires a forged archive, since real tar only links
    // to other in-archive members; that path is covered by the code review and
    // the absolute-member / symlink cases above.)
    const linkDir = await mkdtemp(path.join(tmpdir(), 'profile-hardlink-'));
    try {
      await writeFile(path.join(linkDir, 'a'), 'data');
      await exec('ln', [path.join(linkDir, 'a'), path.join(linkDir, 'b')]);
      const tar = path.join(dir, 'hardlink.tar.gz');
      await exec('tar', ['-czf', tar, '-C', linkDir, 'a', 'b']);
      await expect(assertSafeTarMembers(tar)).resolves.toBeUndefined();
    } finally {
      await rm(linkDir, { recursive: true, force: true });
    }
  });
});

describe('parseJobInput', () => {
  const valid = {
    taskId: 't1',
    callbackUrl: 'http://localhost:8787/webhooks/browser/callback',
    callbackToken: 'tok',
    plan: { goal: 'g', rung: 'headless', steps: [{ action: 'goto', url: 'https://x.test' }] },
    storage: { driver: 'local', root: '/tmp/ws' },
  };

  it('accepts a complete input', () => {
    expect(parseJobInput(JSON.stringify(valid)).taskId).toBe('t1');
  });

  it.each([
    ['missing env', undefined, /not set/],
    ['no token', JSON.stringify({ ...valid, callbackToken: '' }), /callbackToken/],
    ['no steps', JSON.stringify({ ...valid, plan: { ...valid.plan, steps: [] } }), /steps/],
    ['no storage', JSON.stringify({ ...valid, storage: undefined }), /storage/],
  ])('rejects %s', (_label, raw, pattern) => {
    expect(() => parseJobInput(raw as string | undefined)).toThrow(pattern);
  });
});
