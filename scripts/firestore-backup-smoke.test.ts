import { describe, expect, it, vi } from 'vitest';
import type {
  ManagedBackupManifest,
  ManagedFirestoreDataClient,
} from '../packages/firestore/src/managed-backup.js';
import { type BackupSmokeDependencies, firestoreBackupSmoke } from './firestore-backup-smoke.js';

const tuple = <T>(value: T): [T] => [value];
const input = {
  projectId: 'customer-project',
  location: 'us-west1',
  gcsPrefix: 'gs://customer-rehearsal/synthetic-firestore-validation/run',
};

function fixture() {
  let milliseconds = Date.parse('2026-09-19T12:34:20Z');
  const writes: Array<{ path: string; value: unknown }> = [];
  const terminated: string[] = [];
  const dataClosed: string[] = [];
  const deleted: string[] = [];
  const progress = vi.fn();
  const admin = {
    createDatabase: vi.fn(async () =>
      tuple({ promise: async () => tuple({ createTime: { seconds: 1, nanos: 0 } }) }),
    ),
    exportDocuments: vi.fn(),
    importDocuments: vi.fn(),
    deleteDatabase: vi.fn(async ({ name }: { name: string }) => {
      deleted.push(name);
      return [];
    }),
    getDatabase: vi.fn(async () => {
      throw Object.assign(new Error('missing'), { code: 5 });
    }),
  } as unknown as BackupSmokeDependencies['admin'];
  const manifest = {
    format: 'assistant-firestore-managed-backup',
    formatVersion: 2,
    createdAt: '2026-09-19T12:35:01.000Z',
    source: {
      projectId: input.projectId,
      databaseId: 'assistant-validation-fixedrun123456',
      installationId: 'backup-smoke-fixedrun123456',
      databaseName: 'projects/customer-project/databases/assistant-validation-fixedrun123456',
      installationRoot: 'installations/synthetic',
    },
    export: {
      snapshotTime: '2026-09-19T12:35:00.000Z',
      requestedOutputUriPrefix: input.gcsPrefix,
      outputUriPrefix: `${input.gcsPrefix}/export-1`,
      metadataObjectUri: `${input.gcsPrefix}/export-1/export-1.overall_export_metadata`,
      objects: [
        {
          uri: `${input.gcsPrefix}/export-1/export-1.overall_export_metadata`,
          generation: '1',
          size: '1',
          crc32c: 'crc',
        },
      ],
      operationName: 'operations/export',
      completed: true,
    },
    inventory: {
      documents: 2,
      externalReferences: 0,
      collections: {},
      installationRoots: ['installations/synthetic'],
      outOfScopeDocuments: 0,
      canonicalHash: 'hash',
    },
  } satisfies ManagedBackupManifest;
  const backup = vi.fn(
    async (request: Parameters<NonNullable<BackupSmokeDependencies['backup']>>[0]) => {
      expect(request.snapshotTime.toISOString()).toBe('2026-09-19T12:35:00.000Z');
      expect(request.outputUriPrefix).toBe(input.gcsPrefix);
      return manifest;
    },
  );
  const restore = vi.fn(
    async (request: Parameters<NonNullable<BackupSmokeDependencies['restore']>>[0]) => {
      const [operation] = await request.admin.createDatabase({
        parent: 'projects/customer-project',
        databaseId: 'assistant-restore-fixedrun123456',
        database: {
          locationId: 'us-west1',
          type: 'FIRESTORE_NATIVE',
          databaseEdition: 'STANDARD',
        },
      });
      await operation.promise();
      return {
        operationName: 'operations/import',
        completed: true as const,
        verificationReadTime: '2026-09-19T12:35:20.123456Z',
        inventory: manifest.inventory,
      };
    },
  );
  const dependencies: BackupSmokeDependencies = {
    admin,
    createFirestore: (databaseId) => {
      return {
        doc: (path: string) => ({
          set: async (value: unknown) => writes.push({ path, value }),
        }),
        terminate: async () => {
          terminated.push(databaseId);
        },
      } as never;
    },
    createDataClient: (databaseId) =>
      ({
        db: {
          close: async () => {
            dataClosed.push(databaseId);
          },
        },
      }) as unknown as ManagedFirestoreDataClient,
    listObjects: vi.fn(),
    now: () => new Date(milliseconds),
    sleep: async (delay) => {
      milliseconds += delay;
    },
    id: () => 'fixedrun123456',
    backup,
    restore,
  };
  return {
    dependencies,
    admin,
    backup,
    restore,
    writes,
    terminated,
    dataClosed,
    deleted,
    manifest,
    progress,
  };
}

describe('synthetic managed backup smoke', () => {
  it('seeds mixed values, backs up at a later whole minute, restores, and deletes both databases', async () => {
    const state = fixture();
    const result = await firestoreBackupSmoke(
      { ...input, progress: state.progress },
      state.dependencies,
    );

    expect(state.admin.createDatabase).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        databaseId: 'assistant-validation-fixedrun123456',
        database: expect.objectContaining({
          pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_ENABLED',
        }),
      }),
    );
    expect(state.writes).toHaveLength(2);
    expect(state.writes.map((write) => write.path)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/fixtures/mixed-types'),
        expect.stringContaining('/missingParents/absent/children/leaf'),
      ]),
    );
    const mixed = state.writes.find((write) => write.path.endsWith('/fixtures/mixed-types'))
      ?.value as {
      referenceValue: unknown;
      nestedReferences: {
        local: { direct: unknown; array: unknown[] };
      };
    };
    expect(mixed.nestedReferences.local).toEqual({
      direct: mixed.referenceValue,
      array: [mixed.referenceValue],
    });
    expect(state.backup).toHaveBeenCalledOnce();
    expect(state.restore).toHaveBeenCalledOnce();
    expect(result.manifest.export.objects).toEqual(state.manifest.export.objects);
    expect(state.terminated).toEqual(['assistant-validation-fixedrun123456']);
    expect(state.dataClosed.sort()).toEqual([
      'assistant-restore-fixedrun123456',
      'assistant-validation-fixedrun123456',
    ]);
    expect(state.deleted.sort()).toEqual([
      'projects/customer-project/databases/assistant-restore-fixedrun123456',
      'projects/customer-project/databases/assistant-validation-fixedrun123456',
    ]);
    expect(state.progress.mock.calls.map(([stage]) => stage)).toEqual([
      'creating',
      'seeding',
      'exporting',
      'restoring',
      'cleanup',
    ]);
  });

  it('does not delete a restore database when its exclusive create is rejected', async () => {
    const state = fixture();
    const originalCreate = state.dependencies.admin.createDatabase;
    state.dependencies.admin.createDatabase = async (request) => {
      if (request.databaseId.startsWith('assistant-restore-')) throw new Error('creation rejected');
      return originalCreate(request);
    };
    state.dependencies.restore = async (request) => {
      await request.admin.createDatabase({
        parent: 'projects/customer-project',
        databaseId: 'assistant-restore-fixedrun123456',
        database: {
          locationId: 'us-west1',
          type: 'FIRESTORE_NATIVE',
          databaseEdition: 'STANDARD',
        },
      });
      throw new Error('unreachable');
    };
    await expect(firestoreBackupSmoke(input, state.dependencies)).rejects.toThrow(
      'creation rejected',
    );
    expect(state.deleted).toEqual([
      'projects/customer-project/databases/assistant-validation-fixedrun123456',
    ]);
  });

  it('deletes both owned databases when the accepted restore creation operation fails', async () => {
    const state = fixture();
    const originalCreate = state.dependencies.admin.createDatabase;
    state.dependencies.admin.createDatabase = async (request) => {
      if (!request.databaseId.startsWith('assistant-restore-')) return originalCreate(request);
      return tuple({
        promise: async () => {
          throw new Error('restore operation failed');
        },
      });
    };
    await expect(firestoreBackupSmoke(input, state.dependencies)).rejects.toThrow(
      'restore operation failed',
    );
    expect(state.deleted.sort()).toEqual([
      'projects/customer-project/databases/assistant-restore-fixedrun123456',
      'projects/customer-project/databases/assistant-validation-fixedrun123456',
    ]);
  });

  it('deletes nothing when source creation is rejected as a collision', async () => {
    const state = fixture();
    state.dependencies.admin.createDatabase = async () => {
      throw Object.assign(new Error('already exists'), { code: 6 });
    };
    await expect(firestoreBackupSmoke(input, state.dependencies)).rejects.toThrow('already exists');
    expect(state.deleted).toEqual([]);
  });

  it('reports cleanup failures together with the primary smoke failure', async () => {
    const state = fixture();
    const originalDelete = state.dependencies.admin.deleteDatabase;
    state.dependencies.admin.deleteDatabase = async (request, options) => {
      if (request.name.includes('assistant-restore-')) throw new Error('restore cleanup failed');
      return originalDelete(request, options);
    };
    state.dependencies.restore = async (request) => {
      const [operation] = await request.admin.createDatabase({
        parent: 'projects/customer-project',
        databaseId: 'assistant-restore-fixedrun123456',
        database: {
          locationId: 'us-west1',
          type: 'FIRESTORE_NATIVE',
          databaseEdition: 'STANDARD',
        },
      });
      await operation.promise();
      throw new Error('parity failed');
    };

    const error = await firestoreBackupSmoke(
      { ...input, progress: state.progress },
      state.dependencies,
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'parity failed' }),
      expect.objectContaining({ message: 'restore cleanup failed' }),
    ]);
    expect(state.progress).toHaveBeenCalledWith('cleanup_failed', {
      failures: ['restore cleanup failed'],
    });
    expect(state.deleted).toContain(
      'projects/customer-project/databases/assistant-validation-fixedrun123456',
    );
  });

  it('retries a transient concurrent delete and removes both owned databases', async () => {
    const state = fixture();
    const originalDelete = state.dependencies.admin.deleteDatabase;
    let transient = true;
    let attempts = 0;
    state.dependencies.admin.deleteDatabase = async (request, options) => {
      attempts++;
      if (request.name.includes('assistant-restore-') && transient) {
        transient = false;
        throw Object.assign(new Error('concurrent database changes'), { code: 10 });
      }
      return originalDelete(request, options);
    };

    await firestoreBackupSmoke(input, state.dependencies);

    expect(attempts).toBe(3);
    expect(state.deleted.sort()).toEqual([
      'projects/customer-project/databases/assistant-restore-fixedrun123456',
      'projects/customer-project/databases/assistant-validation-fixedrun123456',
    ]);
  });
});
