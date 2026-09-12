import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  advanceInstallationStage,
  createInstallationManifest,
  type InstallationManifest,
  serializeInstallationManifest,
} from './installation-manifest.js';
import { sha256File, verifyInstallationArchive } from './installation-provenance.js';
import {
  persistInstallationManifest,
  persistInstallationProgress,
  readPersistedInstallation,
  resumePersistedInstallation,
} from './installation-state.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'assistant-install-state-'));
  temporaryDirectories.push(directory);
  return directory;
}

function manifest(
  overrides: Partial<InstallationManifest['selection']> = {},
): InstallationManifest {
  return createInstallationManifest({
    identity: {
      installationId: 'state-installation',
      projectId: 'state-project-123',
      region: 'us-west1',
      databaseId: 'assistant-db',
      release: {
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        archiveDigest: `sha256:${'0'.repeat(64)}`,
      },
    },
    modules: overrides.modules ?? [],
    modelProvider: overrides.modelProvider ?? 'google',
    ...(overrides.embeddingModel === undefined ? {} : { embeddingModel: overrides.embeddingModel }),
    ...(overrides.embeddingDimension === undefined
      ? {}
      : { embeddingDimension: overrides.embeddingDimension }),
    resources: [],
    createdAt: '2026-09-12T12:00:00.000Z',
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('installation archive provenance', () => {
  it('verifies a local archive digest and rejects a mismatch', async () => {
    const directory = await temporaryDirectory();
    const archive = path.join(directory, 'source.tar.gz');
    await writeFile(archive, 'offline source archive');
    const digest = await sha256File(archive);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await verifyInstallationArchive(archive, digest.toUpperCase())).toBe(digest);
    await expect(verifyInstallationArchive(archive, `sha256:${'f'.repeat(64)}`)).rejects.toThrow(
      'digest mismatch',
    );
    await expect(sha256File(directory)).rejects.toThrow('regular file');
  });
});

describe('persisted installation state', () => {
  it('writes atomically, reads back, and detects stale expected state', async () => {
    const directory = await temporaryDirectory();
    const statePath = path.join(directory, 'state', 'manifest.json');
    const first = manifest();
    const second = manifest({ modelProvider: 'openrouter' });

    expect(await readPersistedInstallation(statePath)).toBeNull();
    await persistInstallationManifest(statePath, first);
    expect(await readPersistedInstallation(statePath)).toEqual(first);
    const staleExpected = {
      ...first,
      stage: { ...first.stage, updatedAt: '2026-09-12T12:01:00.000Z' },
    } as InstallationManifest;
    await expect(persistInstallationManifest(statePath, first, staleExpected)).rejects.toThrow(
      'conflict',
    );
    await expect(persistInstallationManifest(statePath, second)).rejects.toThrow(
      'immutable installation selection',
    );
    await expect(persistInstallationManifest(statePath, second, first)).rejects.toThrow(
      'immutable installation selection',
    );
    await persistInstallationManifest(statePath, first, first);
    expect(await readPersistedInstallation(statePath)).toEqual(first);
  });

  it('rejects corrupt state and cleans up after a failed rename', async () => {
    const directory = await temporaryDirectory();
    const corrupt = path.join(directory, 'corrupt.json');
    await writeFile(corrupt, '{not json');
    await expect(readPersistedInstallation(corrupt)).rejects.toThrow('invalid JSON');

    const blockedParent = path.join(directory, 'blocked');
    await writeFile(blockedParent, 'not a directory');
    const target = path.join(blockedParent, 'manifest.json');
    await expect(persistInstallationManifest(target, manifest())).rejects.toThrow('write failed');
    const entries = await readdir(directory);
    expect(entries).not.toContain('target.lock');
    expect(entries.some((entry) => entry.startsWith('.target.') && entry.endsWith('.tmp'))).toBe(
      false,
    );
  });

  it('allows one concurrent first writer and rejects the other', async () => {
    const directory = await temporaryDirectory();
    const statePath = path.join(directory, 'manifest.json');
    const outcomes = await Promise.allSettled([
      persistInstallationManifest(statePath, manifest()),
      persistInstallationManifest(statePath, manifest({ modelProvider: 'openrouter' })),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  });

  it('preserves an existing cloud-stage manifest and fails closed on a leftover lock', async () => {
    const directory = await temporaryDirectory();
    const advancedPath = path.join(directory, 'advanced.json');
    const advanced = advanceInstallationStage(manifest(), 'authorized', '2026-09-12T12:01:00.000Z');
    await writeFile(advancedPath, `${serializeInstallationManifest(advanced)}\n`);
    await expect(persistInstallationManifest(advancedPath, manifest(), advanced)).rejects.toThrow(
      'cloud-stage',
    );
    expect(await readPersistedInstallation(advancedPath)).toEqual(advanced);

    const lockedPath = path.join(directory, 'locked.json');
    const current = manifest();
    await persistInstallationManifest(lockedPath, current);
    await writeFile(`${lockedPath}.lock`, 'crashed writer\n');
    await expect(persistInstallationManifest(lockedPath, current, current)).rejects.toThrow(
      'being updated by another local writer',
    );
    expect(await readPersistedInstallation(lockedPath)).toEqual(current);
  });

  it('requires exact identity and selection compatibility before resume', async () => {
    const directory = await temporaryDirectory();
    const statePath = path.join(directory, 'manifest.json');
    const current = manifest();
    await persistInstallationManifest(statePath, current);

    await expect(
      resumePersistedInstallation(statePath, {
        identity: { ...current.identity, projectId: 'other-project-123' },
        modules: [],
        modelProvider: 'google',
      }),
    ).rejects.toThrow('identity does not match');
    await expect(
      resumePersistedInstallation(statePath, {
        identity: current.identity,
        modules: ['sms'],
        modelProvider: 'google',
      }),
    ).rejects.toThrow('selection does not match');
    await expect(
      resumePersistedInstallation(statePath, {
        identity: current.identity,
        modules: [],
        modelProvider: 'google',
        embeddingModel: 'different-model',
      }),
    ).rejects.toThrow('selection does not match');
    await expect(
      resumePersistedInstallation(statePath, {
        identity: current.identity,
        modules: [],
        modelProvider: 'google',
      }),
    ).resolves.toEqual(current);
  });

  it('never persists a manifest with a cloud stage marked complete', async () => {
    const directory = await temporaryDirectory();
    const statePath = path.join(directory, 'manifest.json');
    const advanced = advanceInstallationStage(manifest(), 'authorized', '2026-09-12T12:01:00.000Z');
    await expect(persistInstallationManifest(statePath, advanced)).rejects.toThrow(
      'active previewed manifest',
    );
  });

  it('only persists the immediate cloud stage and keeps identity and selection immutable', async () => {
    const directory = await temporaryDirectory();
    const statePath = path.join(directory, 'manifest.json');
    const preview = manifest();
    const authorized = advanceInstallationStage(preview, 'authorized', '2026-09-12T12:01:00.000Z');
    await persistInstallationProgress(statePath, authorized, null);
    const forged = advanceInstallationStage(authorized, 'bootstrapped', '2026-09-12T12:02:00.000Z');
    await expect(
      persistInstallationProgress(
        statePath,
        {
          ...forged,
          identity: { ...forged.identity, projectId: 'other-project-123' },
        },
        authorized,
      ),
    ).rejects.toThrow('immutable installation identity');
    const skipped = advanceInstallationStage(forged, 'provisioned', '2026-09-12T12:03:00.000Z');
    await expect(persistInstallationProgress(statePath, skipped, authorized)).rejects.toThrow(
      'immediate next stage',
    );
  });
});
