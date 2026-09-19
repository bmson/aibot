import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createManagedFirestoreBackup,
  inventoryFirestoreDatabase,
  type ManagedBackupManifest,
  type ManagedFirestoreAdmin,
  ManagedFirestoreDataClient,
  type ManagedFirestoreRawClient,
  restoreManagedFirestoreBackup,
  type VerifiedGcsObject,
} from './managed-backup.js';
import { documentKey } from './store.js';

afterEach(() => vi.unstubAllEnvs());
const identity = {
  projectId: 'customer-project',
  databaseId: 'assistant-primary',
  installationId: 'customer-installation',
};
const rootFor = (databaseId: string) =>
  `projects/${identity.projectId}/databases/${databaseId}/documents`;
const installation = documentKey(identity.installationId);
const endTime = (iso: string) => {
  const date = new Date(iso);
  return { seconds: Math.floor(date.getTime() / 1000), nanos: date.getUTCMilliseconds() * 1e6 };
};
const objects: VerifiedGcsObject[] = [
  {
    uri: 'gs://customer-backups/firestore/run/export-1/all_namespaces/kind_tasks/output-0',
    generation: '8',
    size: '200',
    crc32c: 'data-crc',
  },
  {
    uri: 'gs://customer-backups/firestore/run/export-1/export-1.overall_export_metadata',
    generation: '7',
    size: '100',
    crc32c: 'meta-crc',
  },
];
const dataObject = objects[0];
const metadataObject = objects[1];
if (!dataObject || !metadataObject) throw new Error('test object fixtures are incomplete');
const tuple = <T>(value: T): [T] => [value];

function rawClient(databaseId: string, populatedAtOrAfter = 0): ManagedFirestoreRawClient {
  const root = rootFor(databaseId);
  const parent = `${root}/installations/${installation}`;
  const task = `${parent}/tasks/task-1`;
  const nested = `${task}/runtime/attempt-1`;
  const populated = (input: { readTime: { seconds?: number | string | null } }) =>
    Number(input.readTime.seconds) >= populatedAtOrAfter;
  return {
    listCollectionIds: vi.fn(async (input) => {
      if (!populated(input)) return tuple([]);
      if (input.parent === root) return tuple(['installations']);
      if (input.parent === parent) return tuple(['tasks']);
      if (input.parent === task) return tuple(['runtime']);
      return tuple([]);
    }),
    listDocuments: vi.fn(async (input) => {
      if (!populated(input)) return tuple([]);
      if (input.parent === root && input.collectionId === 'installations')
        return tuple(input.showMissing ? [{ name: parent }] : []); // missing parent with descendants
      if (input.parent === parent && input.collectionId === 'tasks')
        return tuple([
          {
            name: task,
            createTime: { seconds: 1, nanos: 0 },
            fields: {
              integer: { integerValue: '1' },
              double: { doubleValue: 1 },
              reference: { referenceValue: 'projects/source/databases/(default)/documents/x/y' },
                timestamp: { timestampValue: { seconds: '123', nanos: 456 } },
                protobufDefaults: {
                  nullValue: null,
                  booleanValue: null,
                  integerValue: null,
                  doubleValue: null,
                  timestampValue: null,
                  stringValue: 'kept',
                },
            },
          },
        ]);
      if (input.parent === task && input.collectionId === 'runtime')
        return tuple([
          {
            name: nested,
            updateTime: { seconds: 2, nanos: 0 },
            fields: {
              payload: { mapValue: { fields: { bytes: { bytesValue: Buffer.from('ok') } } } },
            },
          },
        ]);
      return tuple([]);
    }),
  };
}

const dataClient = (databaseId: string, raw = rawClient(databaseId)) =>
  ManagedFirestoreDataClient.fromClient(raw, { projectId: identity.projectId, databaseId });

function adminMock() {
  const exportOperation = {
    name: 'operations/export-1',
    promise: vi.fn(async () => [
      { outputUriPrefix: 'gs://customer-backups/firestore/run/export-1' },
    ]),
  };
  const importOperation = {
    name: 'operations/import-1',
    promise: vi.fn(async () => [
      {},
      {
        endTime: {
          ...endTime('2026-09-19T00:00:20.000Z'),
          nanos: 123_456_000,
        },
      },
    ]),
  };
  const createOperation = {
    name: 'operations/create-1',
    promise: vi.fn(async () => [{ createTime: endTime('2026-09-19T00:00:10.000Z') }, {}]),
  };
  return {
    exportOperation,
    importOperation,
    admin: {
      createDatabase: vi.fn(async () => [createOperation]),
      exportDocuments: vi.fn(async () => [exportOperation]),
      importDocuments: vi.fn(async () => [importOperation]),
    } as unknown as ManagedFirestoreAdmin,
  };
}

describe('raw managed Firestore inventory', () => {
  it('uses one readTime, showMissing recursion, and preserves protobuf value types', async () => {
    const raw = rawClient(identity.databaseId);
    const at = new Date('2026-09-18T23:59:00.123Z');
    const inventory = await inventoryFirestoreDatabase(raw, identity, at);
    expect(inventory).toMatchObject({
      documents: 2,
      collections: {
        [`installations/${installation}/tasks`]: 1,
        [`installations/${installation}/tasks/task-1/runtime`]: 1,
      },
      installationRoots: [`installations/${installation}`],
      outOfScopeDocuments: 0,
    });
    expect(raw.listDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        showMissing: true,
        readTime: { seconds: 1_789_775_940, nanos: 123_000_000 },
      }),
    );
    const normalized = rawClient(identity.databaseId);
    const normalizedList = normalized.listDocuments;
    normalized.listDocuments = vi.fn(async (input) => {
      const result = await normalizedList(input);
      const docs = result[0];
      if (docs[0]?.fields?.protobufDefaults)
        docs[0] = {
          ...docs[0],
          fields: { ...docs[0].fields, protobufDefaults: { stringValue: 'kept' } },
        };
      return result;
    });
    expect(
      (await inventoryFirestoreDatabase(normalized, identity, at)).canonicalHash,
    ).toBe(inventory.canonicalHash);
    const changed = rawClient(identity.databaseId);
    const original = changed.listDocuments;
    changed.listDocuments = vi.fn(async (input) => {
      const result = await original(input);
      const docs = result[0];
      if (docs[0]?.fields?.integer) {
        docs[0] = { ...docs[0], fields: { ...docs[0].fields, integer: { doubleValue: 1 } } };
      }
      return result;
    });
    const changedInventory = await inventoryFirestoreDatabase(changed, identity, at);
    expect(changedInventory.canonicalHash).not.toBe(inventory.canonicalHash);
  });

  it('bounds recursive parent discovery to sixteen concurrent RPCs', async () => {
    const root = rootFor(identity.databaseId);
    let active = 0;
    let maximum = 0;
    const raw: ManagedFirestoreRawClient = {
      listCollectionIds: vi.fn(async ({ parent }) => {
        if (parent === root) return tuple(['parents']);
        active++;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active--;
        return tuple([]);
      }),
      listDocuments: vi.fn(async ({ parent }) =>
        tuple(
          parent === root
            ? Array.from({ length: 40 }, (_, index) => ({
                name: `${root}/parents/${index}`,
              }))
            : [],
        ),
      ),
    };
    await inventoryFirestoreDatabase(raw, identity, new Date('2026-09-18T23:59:00.000Z'));
    expect(maximum).toBe(16);
  });
});

describe('managed Firestore backup and restore', () => {
  it('exports the same snapshot and records every immutable object', async () => {
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '');
    const { admin } = adminMock();
    const snapshotTime = new Date('2026-09-18T23:59:00.000Z');
    const manifest = await createManagedFirestoreBackup({
      admin,
      dataClient: dataClient(identity.databaseId),
      source: identity,
      outputUriPrefix: 'gs://customer-backups/firestore/run',
      snapshotTime,
      listObjects: vi.fn(async () => [...objects].reverse()),
      now: () => new Date('2026-09-19T00:00:00.000Z'),
    });
    expect(admin.exportDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotTime: { seconds: 1_789_775_940, nanos: 0 },
      }),
    );
    expect(manifest.export).toMatchObject({
      snapshotTime: snapshotTime.toISOString(),
      objects,
      metadataObjectUri: metadataObject.uri,
    });
    expect(manifest.inventory.documents).toBe(2);
  });

  it('refuses emulator routing before a managed operation', async () => {
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8789');
    const { admin } = adminMock();
    await expect(
      createManagedFirestoreBackup({
        admin,
        dataClient: dataClient(identity.databaseId),
        source: identity,
        outputUriPrefix: 'gs://customer-backups/firestore/run',
        snapshotTime: new Date('2026-09-18T23:59:00.000Z'),
        listObjects: vi.fn(),
      }),
    ).rejects.toThrow('refuses emulator routing');
    expect(admin.exportDocuments).not.toHaveBeenCalled();
  });

  it('verifies all objects, emptiness, and restored data at operation completion snapshots', async () => {
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '');
    const { admin } = adminMock();
    const sourceInventory = await inventoryFirestoreDatabase(
      rawClient(identity.databaseId),
      identity,
      new Date('2026-09-18T23:59:00.000Z'),
    );
    const manifest: ManagedBackupManifest = {
      format: 'assistant-firestore-managed-backup',
      formatVersion: 2,
      createdAt: '2026-09-19T00:00:00.000Z',
      source: {
        ...identity,
        databaseName: 'projects/customer-project/databases/assistant-primary',
        installationRoot: `installations/${installation}`,
      },
      export: {
        requestedOutputUriPrefix: 'gs://customer-backups/firestore/run',
        outputUriPrefix: 'gs://customer-backups/firestore/run/export-1',
        snapshotTime: '2026-09-18T23:59:00.000Z',
        metadataObjectUri: metadataObject.uri,
        objects,
        operationName: 'operations/export-1',
        completed: true,
      },
      inventory: sourceInventory,
    };
    const targetId = 'assistant-restore-isolated1';
    const raw = rawClient(
      targetId,
      Math.floor(new Date('2026-09-19T00:00:20.000Z').getTime() / 1000),
    );
    const result = await restoreManagedFirestoreBackup({
      admin,
      dataClient: dataClient(targetId, raw),
      target: { ...identity, databaseId: targetId },
      manifest,
      location: 'us-central1',
      listObjects: vi.fn(async () => [...objects]),
    });
    expect(admin.importDocuments).toHaveBeenCalledOnce();
    expect(result.verificationReadTime).toBe('2026-09-19T00:00:20.123456Z');
    expect(result.inventory).toEqual(sourceInventory);
    expect(raw.listCollectionIds).toHaveBeenCalledWith(
      expect.objectContaining({
        readTime: endTime('2026-09-19T00:00:10.000Z'),
      }),
    );
    expect(raw.listCollectionIds).toHaveBeenCalledWith(
      expect.objectContaining({
        readTime: {
          ...endTime('2026-09-19T00:00:20.000Z'),
          nanos: 123_456_000,
        },
      }),
    );
  });

  it('rejects any changed export object before creating the target', async () => {
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '');
    const { admin } = adminMock();
    const inventory = await inventoryFirestoreDatabase(
      rawClient(identity.databaseId),
      identity,
      new Date('2026-09-18T23:59:00.000Z'),
    );
    const manifest = {
      format: 'assistant-firestore-managed-backup',
      formatVersion: 2,
      createdAt: '2026-09-19T00:00:00.000Z',
      source: {
        ...identity,
        databaseName: 'projects/customer-project/databases/assistant-primary',
        installationRoot: `installations/${installation}`,
      },
      export: {
        requestedOutputUriPrefix: 'gs://customer-backups/firestore/run',
        outputUriPrefix: 'gs://customer-backups/firestore/run/export-1',
        snapshotTime: '2026-09-18T23:59:00.000Z',
        metadataObjectUri: metadataObject.uri,
        objects,
        operationName: 'operations/export-1',
        completed: true,
      },
      inventory,
    } satisfies ManagedBackupManifest;
    await expect(
      restoreManagedFirestoreBackup({
        admin,
        dataClient: dataClient('assistant-restore-isolated1'),
        target: { ...identity, databaseId: 'assistant-restore-isolated1' },
        manifest,
        location: 'us-central1',
        listObjects: vi.fn(async () => [{ ...dataObject, generation: 'changed' }, metadataObject]),
      }),
    ).rejects.toThrow('no longer match');
    expect(admin.createDatabase).not.toHaveBeenCalled();
  });
});
