import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import firestore from '@google-cloud/firestore';
import {
  createManagedFirestoreBackup,
  type ManagedBackupManifest,
  type ManagedFirestoreAdmin,
  ManagedFirestoreDataClient,
  restoreManagedFirestoreBackup,
  type VerifiedGcsObject,
} from '../packages/firestore/src/managed-backup.js';
import { documentKey } from '../packages/firestore/src/store.js';
import { createGcloudAuthClient } from './gcloud-auth.js';

type DataFirestore = InstanceType<typeof firestore.Firestore>;
export type BackupSmokeDependencies = {
  admin: ManagedFirestoreAdmin & {
    deleteDatabase(input: { name: string }, options?: { timeout: number }): Promise<unknown>;
    getDatabase(input: { name: string }, options?: { timeout: number }): Promise<unknown>;
  };
  createFirestore(databaseId: string): DataFirestore;
  createDataClient(databaseId: string): ManagedFirestoreDataClient;
  listObjects(prefix: string): Promise<VerifiedGcsObject[]>;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  id?: () => string;
  backup?: typeof createManagedFirestoreBackup;
  restore?: typeof restoreManagedFirestoreBackup;
};

export type BackupSmokeInput = {
  projectId: string;
  location: string;
  gcsPrefix: string;
  progress?: (stage: string, details: Record<string, unknown>) => void;
};

async function deleteOwnedDatabase(
  admin: BackupSmokeDependencies['admin'],
  name: string,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (true) {
    try {
      await admin.deleteDatabase({ name }, { timeout: 30_000 });
      break;
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code === 5) return;
      if (code !== 10 || Date.now() >= deadline) throw error;
      await sleep(2_000);
    }
  }
  while (Date.now() < deadline) {
    try {
      await admin.getDatabase({ name }, { timeout: 5_000 });
    } catch (error) {
      if ((error as { code?: number }).code === 5) return;
      throw error;
    }
    await sleep(1_000);
  }
  throw new Error('Timed out deleting synthetic Firestore database');
}

async function seedSyntheticData(db: DataFirestore, installationId: string): Promise<void> {
  const root = `installations/${documentKey(installationId)}`;
  const reference = db.doc(`${root}/missingParents/reference-only`);
  await Promise.all([
    db.doc(`${root}/fixtures/mixed-types`).set({
      nullValue: null,
      booleanValue: true,
      integerValue: 42,
      doubleValue: 1.25,
      timestampValue: new firestore.Timestamp(1_789_800_000, 123_456_000),
      stringValue: 'synthetic backup smoke',
      bytesValue: Buffer.from('synthetic-bytes'),
      referenceValue: reference,
      nestedReferences: { local: { direct: reference, array: [reference] } },
      geoPointValue: new firestore.GeoPoint(37.7749, -122.4194),
      arrayValue: [null, true, 7, 'nested'],
      mapValue: { nested: { active: true, count: 2 } },
    }),
    // Firestore keeps both ancestors missing while retaining this descendant.
    db.doc(`${root}/missingParents/absent/children/leaf`).set({ retained: true }),
  ]);
}

function nextWholeMinute(now: Date): Date {
  return new Date(Math.ceil((now.getTime() + 1) / 60_000) * 60_000);
}

/** Synthetic export/import proof. GCS export objects are deliberately retained. */
export async function firestoreBackupSmoke(
  input: BackupSmokeInput,
  dependencies: BackupSmokeDependencies,
): Promise<{
  sourceDatabaseId: string;
  restoreDatabaseId: string;
  manifest: ManagedBackupManifest;
  verificationReadTime: string;
}> {
  if (process.env.FIRESTORE_EMULATOR_HOST)
    throw new Error('Managed backup smoke refuses emulator routing');
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(input.projectId))
    throw new Error('Explicit Google project ID required');
  if (!/^[a-z]+(?:-[a-z0-9]+)+$/.test(input.location))
    throw new Error('Explicit Firestore location required');
  if (!/^gs:\/\/[^/]+\/.+[^/]$/.test(input.gcsPrefix) || input.gcsPrefix.includes('..'))
    throw new Error('Explicit synthetic GCS prefix required');

  const id = (dependencies.id ?? randomUUID)().replaceAll('-', '').slice(0, 16).toLowerCase();
  if (!/^[a-z0-9]{8,16}$/.test(id)) throw new Error('Invalid synthetic run identifier');
  const sourceDatabaseId = `assistant-validation-${id}`;
  const restoreDatabaseId = `assistant-restore-${id}`;
  const installationId = `backup-smoke-${id}`;
  const sourceName = `projects/${input.projectId}/databases/${sourceDatabaseId}`;
  const restoreName = `projects/${input.projectId}/databases/${restoreDatabaseId}`;
  const now = dependencies.now ?? (() => new Date());
  const sleep =
    dependencies.sleep ?? ((milliseconds) => new Promise((r) => setTimeout(r, milliseconds)));
  const backup = dependencies.backup ?? createManagedFirestoreBackup;
  const restore = dependencies.restore ?? restoreManagedFirestoreBackup;
  let sourceCreated = false;
  let restoreCreated = false;
  let sourceDb: DataFirestore | undefined;
  let sourceData: ManagedFirestoreDataClient | undefined;
  let restoreData: ManagedFirestoreDataClient | undefined;
  let result:
    | {
        sourceDatabaseId: string;
        restoreDatabaseId: string;
        manifest: ManagedBackupManifest;
        verificationReadTime: string;
      }
    | undefined;
  let smokeError: unknown;
  try {
    input.progress?.('creating', { databaseId: sourceDatabaseId, role: 'source' });
    const [sourceCreation] = await dependencies.admin.createDatabase({
      parent: `projects/${input.projectId}`,
      databaseId: sourceDatabaseId,
      database: {
        locationId: input.location,
        type: 'FIRESTORE_NATIVE',
        databaseEdition: 'STANDARD',
        pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_ENABLED',
      },
    });
    sourceCreated = true;
    await sourceCreation.promise();
    sourceDb = dependencies.createFirestore(sourceDatabaseId);
    input.progress?.('seeding', { databaseId: sourceDatabaseId });
    await seedSyntheticData(sourceDb, installationId);
    const snapshotTime = nextWholeMinute(now());
    await sleep(Math.max(0, snapshotTime.getTime() + 1_000 - now().getTime()));
    sourceData = dependencies.createDataClient(sourceDatabaseId);
    input.progress?.('exporting', {
      databaseId: sourceDatabaseId,
      snapshotTime: snapshotTime.toISOString(),
      outputUriPrefix: input.gcsPrefix,
    });
    const manifest = await backup({
      admin: dependencies.admin,
      dataClient: sourceData,
      source: { projectId: input.projectId, databaseId: sourceDatabaseId, installationId },
      outputUriPrefix: input.gcsPrefix,
      snapshotTime,
      listObjects: dependencies.listObjects,
      now,
    });

    restoreData = dependencies.createDataClient(restoreDatabaseId);
    input.progress?.('restoring', { databaseId: restoreDatabaseId });
    const restoreAdmin: ManagedFirestoreAdmin = {
      exportDocuments: (request) => dependencies.admin.exportDocuments(request),
      importDocuments: (request) => dependencies.admin.importDocuments(request),
      getDatabase: (request) => dependencies.admin.getDatabase(request),
      createDatabase: async (request) => {
        const [operation, ...rest] = await dependencies.admin.createDatabase(request);
        restoreCreated = true;
        const tracked = {
          ...operation,
          promise: () => operation.promise(),
        };
        return [tracked, ...rest];
      },
    };
    const restored = await restore({
      admin: restoreAdmin,
      dataClient: restoreData,
      target: { projectId: input.projectId, databaseId: restoreDatabaseId, installationId },
      manifest,
      location: input.location,
      listObjects: dependencies.listObjects,
    });
    result = {
      sourceDatabaseId,
      restoreDatabaseId,
      manifest,
      verificationReadTime: restored.verificationReadTime,
    };
  } catch (error) {
    smokeError = error;
  }
  input.progress?.('cleanup', {
    sourceDatabaseId: sourceCreated ? sourceDatabaseId : null,
    restoreDatabaseId: restoreCreated ? restoreDatabaseId : null,
    retainedExportPrefix: input.gcsPrefix,
  });
  const cleanup = await Promise.allSettled([
    sourceDb?.terminate(),
    sourceData?.db.close?.(),
    restoreData?.db.close?.(),
  ]);
  const cleanupFailures: unknown[] = cleanup.flatMap((settled) =>
    settled.status === 'rejected' ? [settled.reason] : [],
  );
  for (const name of [
    restoreCreated ? restoreName : undefined,
    sourceCreated ? sourceName : undefined,
  ]) {
    if (!name) continue;
    try {
      await deleteOwnedDatabase(dependencies.admin, name, sleep);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupFailures.length) {
    input.progress?.('cleanup_failed', {
      failures: cleanupFailures.map((failure) =>
        failure instanceof Error ? failure.message : String(failure),
      ),
    });
    throw new AggregateError(
      [...(smokeError === undefined ? [] : [smokeError]), ...cleanupFailures],
      smokeError === undefined
        ? 'Synthetic backup smoke cleanup failed'
        : 'Synthetic backup smoke and cleanup both failed',
    );
  }
  if (smokeError !== undefined) throw smokeError;
  if (!result) throw new Error('Synthetic backup smoke produced no result');
  return result;
}

function parseGcsUri(uri: string): { bucket: string; object: string } {
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match?.[1] || !match[2]) throw new Error('Invalid GCS object URI');
  return { bucket: match[1], object: match[2] };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      project: { type: 'string' },
      location: { type: 'string' },
      'gcs-prefix': { type: 'string' },
      run: { type: 'boolean', default: false },
      'gcloud-auth': { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (!values.project || !values.location || !values['gcs-prefix'])
    throw new Error('--project, --location, and --gcs-prefix are required');
  if (!values.run) {
    console.log(
      JSON.stringify(
        {
          mode: 'preview',
          projectId: values.project,
          location: values.location,
          gcsPrefix: values['gcs-prefix'],
          databases: ['assistant-validation-*', 'assistant-restore-*'],
          cleanup: 'both synthetic databases; exported GCS objects retained',
          authentication: values['gcloud-auth'] ? 'active-gcloud-account' : 'ADC',
          execute: 'Add --run to create billable temporary cloud resources',
        },
        null,
        2,
      ),
    );
    return;
  }
  if (process.env.FIRESTORE_EMULATOR_HOST)
    throw new Error('Managed backup smoke refuses emulator routing');
  const authClient = values['gcloud-auth'] ? await createGcloudAuthClient() : undefined;
  const admin = new firestore.v1.FirestoreAdminClient({ projectId: values.project, authClient });
  const firestoreOptions = (databaseId: string) =>
    ({
      projectId: values.project,
      databaseId,
      authClient,
    }) as ConstructorParameters<typeof firestore.Firestore>[0] & { authClient?: object };
  const listObjects = async (uri: string): Promise<VerifiedGcsObject[]> => {
    const { bucket, object } = parseGcsUri(uri);
    const result: VerifiedGcsObject[] = [];
    let pageToken: string | undefined;
    do {
      const token = await admin.auth.getAccessToken();
      if (!token) throw new Error('Google authentication did not provide an access token');
      const query = new URLSearchParams({
        prefix: `${object}/`,
        fields: 'nextPageToken,items(bucket,name,generation,size,crc32c)',
      });
      if (pageToken) query.set('pageToken', pageToken);
      const response = await fetch(
        `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o?${query}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!response.ok) throw new Error(`GCS object inventory failed with HTTP ${response.status}`);
      const body = (await response.json()) as {
        nextPageToken?: string;
        items?: Array<Partial<Omit<VerifiedGcsObject, 'uri'>> & { bucket?: string; name?: string }>;
      };
      for (const item of body.items ?? []) {
        if (
          item.bucket !== bucket ||
          !item.name?.startsWith(`${object}/`) ||
          !item.generation ||
          !item.size ||
          !item.crc32c
        )
          throw new Error('GCS object inventory returned incomplete metadata');
        result.push({
          uri: `gs://${bucket}/${item.name}`,
          generation: item.generation,
          size: item.size,
          crc32c: item.crc32c,
        });
      }
      pageToken = body.nextPageToken;
    } while (pageToken);
    return result;
  };
  try {
    const result = await firestoreBackupSmoke(
      {
        projectId: values.project,
        location: values.location,
        gcsPrefix: values['gcs-prefix'],
        progress: (stage, details) => console.log(JSON.stringify({ stage, ...details })),
      },
      {
        admin: admin as unknown as BackupSmokeDependencies['admin'],
        createFirestore: (databaseId) => new firestore.Firestore(firestoreOptions(databaseId)),
        createDataClient: (databaseId) =>
          ManagedFirestoreDataClient.create(
            { projectId: values.project as string, databaseId },
            authClient,
          ),
        listObjects,
      },
    );
    console.log(
      JSON.stringify(
        {
          mode: 'complete',
          sourceDatabaseId: result.sourceDatabaseId,
          restoreDatabaseId: result.restoreDatabaseId,
          documents: result.manifest.inventory.documents,
          canonicalHash: result.manifest.inventory.canonicalHash,
          verificationReadTime: result.verificationReadTime,
          retainedExportPrefix: result.manifest.export.outputUriPrefix,
          retainedObjects: result.manifest.export.objects.length,
        },
        null,
        2,
      ),
    );
  } finally {
    await admin.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
