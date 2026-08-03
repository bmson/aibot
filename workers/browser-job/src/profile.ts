import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { BlobStore } from './storage.js';

const exec = promisify(execFile);

/** Where the encrypted profile lives under the agent's workspace prefix. */
const PROFILE_OBJECT = 'browser/profile.tar.enc';

/** Refuse to persist runaway profiles — cookies + storage should stay small. */
const MAX_PROFILE_TARBALL_BYTES = 40 * 1024 * 1024;

/** Chromium cache dirs — regenerable, dominate profile size, never persisted. */
const PRUNE_EXCLUDES = [
  './Default/Cache',
  './Default/Code Cache',
  './Default/GPUCache',
  './Default/DawnGraphiteCache',
  './Default/DawnWebGPUCache',
  './Default/Service Worker/CacheStorage',
  './Default/Service Worker/ScriptCache',
  './GrShaderCache',
  './GraphiteDawnCache',
  './ShaderCache',
  './component_crx_cache',
  './Crashpad',
  './BrowserMetrics',
  './segmentation_platform',
];

/** AES-256-GCM: iv(12) | authTag(16) | ciphertext. Key is 64 hex chars. */
export function encryptProfile(data: Buffer, keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('PROFILE_ENC_KEY must be 32 bytes of hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptProfile(data: Buffer, keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('PROFILE_ENC_KEY must be 32 bytes of hex');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Reject a tarball whose members would write outside profileDir (absolute
 * paths, `..` traversal, or an absolute symlink/hardlink target). `tar -tvzf`
 * lists members and link targets without extracting; any member that fails the
 * check aborts the load, which falls back to a fresh profile.
 */
function isUnsafeTarPath(candidate: string): boolean {
  const normalized = candidate.replace(/\/+$/, '');
  return (
    path.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  );
}

export async function assertSafeTarMembers(tarPath: string): Promise<void> {
  // `-tzf` lists one member name per line with no permission/date columns, so
  // parsing is identical across GNU tar and bsdtar — check every name for an
  // absolute path or `..` traversal.
  const names = await exec('tar', ['-tzf', tarPath]);
  for (const raw of names.stdout.split('\n')) {
    const name = raw.trim();
    if (name && isUnsafeTarPath(name)) throw new Error(`unsafe tar member path: ${name}`);
  }
  // The verbose listing additionally reveals link targets: symlinks render as
  // "<name> -> <target>" and hardlinks as "<name> link to <target>" (both GNU
  // tar and bsdtar). Split on the LAST occurrence of each marker so a filename
  // that itself contains the marker cannot hide an escaping target in the tail.
  const verbose = await exec('tar', ['-tvzf', tarPath]);
  for (const raw of verbose.stdout.split('\n')) {
    for (const marker of [' -> ', ' link to ']) {
      const at = raw.lastIndexOf(marker);
      if (at === -1) continue;
      const target = raw.slice(at + marker.length).trim();
      if (target && isUnsafeTarPath(target)) {
        throw new Error(`unsafe tar link target: ${target}`);
      }
    }
  }
}

/**
 * Download + decrypt + unpack the persisted profile into profileDir.
 * Returns false when no profile exists yet (fresh browser). A corrupt or
 * wrong-key profile also starts fresh — a broken tarball must never brick
 * every future browse.
 */
export async function loadProfile(
  store: BlobStore,
  profileDir: string,
  keyHex: string,
): Promise<boolean> {
  if (!keyHex) throw new Error('PROFILE_ENC_KEY is required when useProfile=true');
  const blob = await store.get(PROFILE_OBJECT);
  if (!blob) return false;
  try {
    const tarball = decryptProfile(blob, keyHex);
    const tarPath = path.join(path.dirname(profileDir), 'profile-in.tar.gz');
    await writeFile(tarPath, tarball);
    await mkdir(profileDir, { recursive: true });
    // Defense-in-depth (a malicious tarball would first have to be forged under
    // PROFILE_ENC_KEY and written to the agent's GCS object): reject any member
    // that would escape profileDir before extracting, and never restore
    // ownership from the archive.
    await assertSafeTarMembers(tarPath);
    await exec('tar', [
      '--no-same-owner',
      '--no-same-permissions',
      '-xzf',
      tarPath,
      '-C',
      profileDir,
    ]);
    await rm(tarPath, { force: true });
    return true;
  } catch (err) {
    console.error('profile load failed — starting fresh:', err);
    await rm(profileDir, { recursive: true, force: true });
    await mkdir(profileDir, { recursive: true });
    return false;
  }
}

/** Pack (minus caches) + encrypt + upload the profile. Returns bytes persisted (0 = skipped). */
export async function saveProfile(
  store: BlobStore,
  profileDir: string,
  keyHex: string,
): Promise<number> {
  if (!keyHex) throw new Error('PROFILE_ENC_KEY is required when useProfile=true');
  const tarPath = path.join(path.dirname(profileDir), 'profile-out.tar.gz');
  const excludes = PRUNE_EXCLUDES.flatMap((e) => ['--exclude', e]);
  await exec('tar', ['-czf', tarPath, ...excludes, '-C', profileDir, '.']);
  const tarball = await readFile(tarPath);
  await rm(tarPath, { force: true });
  if (tarball.length > MAX_PROFILE_TARBALL_BYTES) {
    console.error(`profile tarball ${tarball.length}B exceeds cap — not persisting`);
    return 0;
  }
  const payload = encryptProfile(tarball, keyHex);
  await store.put(PROFILE_OBJECT, payload, 'application/octet-stream');
  return payload.length;
}
