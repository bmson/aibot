import { describe, expect, it, vi } from 'vitest';
import type { MigrationBundle, MigrationRecord } from '../packages/persistence/src/migration.js';
import {
  type AssetRecoveryManifest,
  type AssetRecoveryStorage,
  recoverWorkspaceAssets,
} from './workspace-asset-recovery.js';

const digest = 'a'.repeat(64);
const prefix = 'gs://private/workspace/install/migration-recovery/run/';
const bundle = {
  manifest: {
    formatVersion: 3,
    target: { installationId: 'install' },
  },
  records: [
    {
      table: 'import_sources',
      id: 'recoverable',
      data: { workspacePath: 'import/original.txt', status: 'done' },
    },
    {
      table: 'files',
      id: 'missing',
      data: { workspacePath: 'traces/missing.zip', bytes: 0, sha256: null, taskId: null },
    },
  ] as unknown as MigrationRecord[],
} as unknown as MigrationBundle;
const manifest: AssetRecoveryManifest = {
  destinationPrefix: prefix,
  recovered: [
    {
      sourceRecordId: 'recoverable',
      destination: {
        objectUri: `${prefix}objects/recoverable`,
        generation: '11',
        bytes: 42,
        sha256: digest,
      },
      verified: true,
      createOnly: true,
    },
  ],
  missing: [{ sourceRecordId: 'missing', classification: 'no-byte-candidate' }],
};

function storage(current?: { generation: string; size: number; digest: string }) {
  const objects = new Map([
    ['private/recovery/11', { generation: '11', size: 42, digest }],
    ...(current ? [['target/live/22', current] as const] : []),
  ]);
  const adapter: AssetRecoveryStorage = {
    stat: vi.fn(async (ref) => {
      if (ref.bucket === 'private')
        return objects.get(`private/recovery/${ref.generation}`) ?? null;
      if (ref.bucket === 'target' && ref.generation)
        return objects.get(`target/live/${ref.generation}`) ?? null;
      if (ref.bucket === 'target') return current ?? null;
      return null;
    }),
    sha256: vi.fn(
      async (ref) =>
        objects.get(
          `${ref.bucket}/${ref.name === 'workspace/install/import/original.txt' ? 'live' : 'recovery'}/${ref.generation}`,
        )?.digest ?? digest,
    ),
    copyCreateOnly: vi.fn(async (_source, destination) => {
      expect(destination).toEqual({
        bucket: 'target',
        name: 'workspace/install/import/original.txt',
      });
      objects.set('target/live/23', { generation: '23', size: 42, digest });
      return '23';
    }),
  };
  return adapter;
}

describe('workspace asset recovery', () => {
  it('previews and then performs a generation-pinned create-only copy', async () => {
    const adapter = storage();
    await expect(
      recoverWorkspaceAssets(bundle, manifest, adapter, {
        targetBucket: 'target',
        recoveryPrefix: prefix,
      }),
    ).resolves.toMatchObject({ plannedCopies: 1, copied: 0, unresolvedReferences: 1 });
    expect(adapter.copyCreateOnly).not.toHaveBeenCalled();

    await expect(
      recoverWorkspaceAssets(bundle, manifest, adapter, {
        targetBucket: 'target',
        recoveryPrefix: prefix,
        run: true,
      }),
    ).resolves.toEqual({
      references: 2,
      recoverableReferences: 1,
      unresolvedReferences: 1,
      plannedCopies: 1,
      copied: 1,
      alreadyPresent: 0,
      sourceBytesVerified: 42,
      bytesVerified: 42,
    });
    expect(adapter.copyCreateOnly).toHaveBeenCalledWith(
      {
        bucket: 'private',
        name: 'workspace/install/migration-recovery/run/objects/recoverable',
        generation: '11',
      },
      { bucket: 'target', name: 'workspace/install/import/original.txt' },
    );
  });

  it('is idempotent for identical live bytes and refuses a conflict', async () => {
    const identical = storage({ generation: '22', size: 42, digest });
    await expect(
      recoverWorkspaceAssets(bundle, manifest, identical, {
        targetBucket: 'target',
        recoveryPrefix: prefix,
        run: true,
      }),
    ).resolves.toMatchObject({ alreadyPresent: 1, copied: 0, bytesVerified: 42 });
    expect(identical.copyCreateOnly).not.toHaveBeenCalled();

    const conflict = storage({ generation: '22', size: 41, digest: 'b'.repeat(64) });
    await expect(
      recoverWorkspaceAssets(bundle, manifest, conflict, {
        targetBucket: 'target',
        recoveryPrefix: prefix,
        run: true,
      }),
    ).rejects.toThrow('conflicts');
    expect(conflict.copyCreateOnly).not.toHaveBeenCalled();
  });

  it('rejects unverified, out-of-prefix, and unknown recovery records', async () => {
    const invalid = structuredClone(manifest);
    const recovered = invalid.recovered[0];
    if (!recovered) throw new Error('missing fixture recovery record');
    recovered.destination.objectUri = 'gs://other/untrusted/object';
    await expect(
      recoverWorkspaceAssets(bundle, invalid, storage(), {
        targetBucket: 'target',
        recoveryPrefix: prefix,
      }),
    ).rejects.toThrow('outside the trusted prefix');
  });
});
