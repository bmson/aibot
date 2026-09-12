import { randomUUID } from 'node:crypto';
import { type FileHandle, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  CreateInstallationManifestInput,
  InstallationIdentity,
  InstallationManifest,
  InstallationSelection,
} from './installation-manifest.js';
import {
  createInstallationManifest,
  serializeInstallationManifest,
  validateInstallationManifest,
} from './installation-manifest.js';

export type InstallationResumeInput = Pick<
  CreateInstallationManifestInput,
  'identity' | 'modules' | 'modelProvider' | 'embeddingModel' | 'embeddingDimension'
>;

function stateError(path: string, message: string): Error {
  return new Error(`Installation state ${path}: ${message}`);
}

function canonicalState(manifest: InstallationManifest): string {
  return `${serializeInstallationManifest(manifest)}\n`;
}

/** Read and validate a persisted manifest. Missing state is a normal result. */
export async function readPersistedInstallation(
  path: string,
): Promise<InstallationManifest | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    const detail = error instanceof Error ? error.message : 'read failed';
    throw stateError(path, `cannot read: ${detail}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw stateError(path, 'contains invalid JSON');
  }
  try {
    return validateInstallationManifest(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'manifest validation failed';
    throw stateError(path, `is invalid: ${detail}`);
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const directory = await open(path, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Directory fsync is unavailable on some supported local filesystems. The
    // file itself is still fsynced before rename, which is the important part.
  }
}

/**
 * Persist an offline preview manifest with cooperative conflict detection and
 * an atomic rename.
 * `expected` is null for a first write, or the exact prior manifest for an
 * update. A lock held through read, compare, fsync, and rename prevents two
 * local writers from silently overwriting one another.
 */
export async function persistInstallationManifest(
  path: string,
  manifest: InstallationManifest,
  expected: InstallationManifest | null = null,
): Promise<InstallationManifest> {
  const next = validateInstallationManifest(manifest);
  if (next.status !== 'active' || next.stage.current !== 'previewed') {
    throw stateError(path, 'offline persistence accepts only an active previewed manifest');
  }
  const nextContents = canonicalState(next);
  const parent = dirname(path);
  try {
    await mkdir(parent, { recursive: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'directory creation failed';
    throw stateError(path, `write failed: ${detail}`);
  }
  const lockPath = `${path}.lock`;
  let lock: FileHandle;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw stateError(path, 'is being updated by another local writer');
    }
    const detail = error instanceof Error ? error.message : 'lock failed';
    throw stateError(path, `cannot acquire update lock: ${detail}`);
  }

  let temporaryPath: string | undefined;
  try {
    await lock.writeFile(`${process.pid}\n`, 'utf8');
    await lock.sync();
    const current = await readPersistedInstallation(path);
    if (current && (current.status !== 'active' || current.stage.current !== 'previewed')) {
      throw stateError(
        path,
        'refusing to overwrite an existing cloud-stage or invalidated manifest',
      );
    }
    if (current && !sameJson(current.identity, next.identity)) {
      throw stateError(path, 'refusing to change immutable installation identity');
    }
    if (current && !sameJson(current.selection, next.selection)) {
      throw stateError(path, 'refusing to change immutable installation selection');
    }
    const expectedContents =
      expected === null ? null : canonicalState(validateInstallationManifest(expected));
    const currentContents = current === null ? null : canonicalState(current);
    if (currentContents !== expectedContents) {
      throw stateError(path, 'conflict: persisted state changed since it was read');
    }

    temporaryPath = join(parent, `.${basename(path) || 'installation'}.${randomUUID()}.tmp`);
    const temporary = await open(temporaryPath, 'wx', 0o600);
    try {
      await temporary.writeFile(nextContents, 'utf8');
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    await rename(temporaryPath, path);
    temporaryPath = undefined;
    await syncDirectory(parent);
    return next;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Installation state ')) throw error;
    const detail = error instanceof Error ? error.message : 'write failed';
    throw stateError(path, `write failed: ${detail}`);
  } finally {
    if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

function canonicalResumeSelection(
  input: InstallationResumeInput,
  stageUpdatedAt: string,
): {
  identity: InstallationIdentity;
  selection: InstallationSelection;
} {
  const candidate = createInstallationManifest({
    ...input,
    resources: [],
    createdAt: stageUpdatedAt,
  });
  return { identity: candidate.identity, selection: candidate.selection };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Read a persisted manifest and verify every immutable resume choice before
 * returning it. This performs no stage transition and never writes cloud state.
 */
export async function resumePersistedInstallation(
  path: string,
  expected: InstallationResumeInput,
): Promise<InstallationManifest> {
  const current = await readPersistedInstallation(path);
  if (!current) throw stateError(path, 'does not exist; nothing can be resumed');
  if (current.status === 'invalidated') {
    throw stateError(path, `is invalidated: ${current.invalidation?.reason ?? 'identity changed'}`);
  }
  const candidate = canonicalResumeSelection(expected, current.stage.updatedAt);
  if (!sameJson(current.identity, candidate.identity)) {
    throw stateError(path, 'cannot resume: immutable installation identity does not match');
  }
  if (!sameJson(current.selection, candidate.selection)) {
    throw stateError(path, 'cannot resume: installation selection does not match');
  }
  return current;
}
