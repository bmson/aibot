import { createHash } from 'node:crypto';
import firestore from '@google-cloud/firestore';
import { documentKey } from './store.js';

export type FirestoreIdentity = { projectId: string; databaseId: string; installationId: string };
type ProtoTimestamp = { seconds?: unknown; nanos?: number | null };
type ProtoValue = {
  nullValue?: unknown;
  booleanValue?: boolean | null;
  integerValue?: number | string | null;
  doubleValue?: number | null;
  timestampValue?: ProtoTimestamp | null;
  stringValue?: string | null;
  bytesValue?: Uint8Array | null;
  referenceValue?: string | null;
  geoPointValue?: { latitude?: number | null; longitude?: number | null } | null;
  arrayValue?: { values?: ProtoValue[] | null } | null;
  mapValue?: { fields?: Record<string, ProtoValue> | null } | null;
};
type ProtoDocument = {
  name?: string | null;
  fields?: Record<string, ProtoValue> | null;
  createTime?: ProtoTimestamp | null;
  updateTime?: ProtoTimestamp | null;
};
export type ManagedFirestoreRawClient = {
  listCollectionIds(input: {
    parent: string;
    readTime: ProtoTimestamp;
  }): Promise<[string[], ...unknown[]]>;
  listDocuments(input: {
    parent: string;
    collectionId: string;
    readTime: ProtoTimestamp;
    showMissing: boolean;
  }): Promise<[ProtoDocument[], ...unknown[]]>;
  close?(): Promise<void>;
};

export class ManagedFirestoreDataClient {
  private constructor(
    readonly db: ManagedFirestoreRawClient,
    readonly projectId: string,
    readonly databaseId: string,
  ) {}
  static create(
    identity: Pick<FirestoreIdentity, 'projectId' | 'databaseId'>,
    authClient?: object,
  ) {
    return new ManagedFirestoreDataClient(
      new firestore.v1.FirestoreClient({
        projectId: identity.projectId,
        databaseId: identity.databaseId,
        ...(authClient ? { authClient } : {}),
      } as ConstructorParameters<
        typeof firestore.v1.FirestoreClient
      >[0]) as ManagedFirestoreRawClient,
      identity.projectId,
      identity.databaseId,
    );
  }
  static fromClient(
    db: ManagedFirestoreRawClient,
    identity: Pick<FirestoreIdentity, 'projectId' | 'databaseId'>,
  ) {
    return new ManagedFirestoreDataClient(db, identity.projectId, identity.databaseId);
  }
}

export type DatabaseInventory = {
  documents: number;
  collections: Record<string, number>;
  installationRoots: string[];
  outOfScopeDocuments: number;
  externalReferences: number;
  canonicalHash: string;
};
export type VerifiedGcsObject = {
  uri: string;
  generation: string;
  size: string;
  crc32c: string;
};
export type ManagedBackupManifest = {
  format: 'assistant-firestore-managed-backup';
  formatVersion: 2;
  createdAt: string;
  source: FirestoreIdentity & { databaseName: string; installationRoot: string };
  export: {
    snapshotTime: string;
    requestedOutputUriPrefix: string;
    outputUriPrefix: string;
    metadataObjectUri: string;
    objects: VerifiedGcsObject[];
    operationName: string;
    completed: true;
  };
  inventory: DatabaseInventory;
};
type LongRunningOperation<T> = {
  name?: string;
  promise(): Promise<[T, { endTime?: ProtoTimestamp | null }?, ...unknown[]]>;
};
export type ManagedFirestoreAdmin = {
  getDatabase(input: { name: string }): Promise<
    [
      {
        pointInTimeRecoveryEnablement?: string | number | null;
        earliestVersionTime?: ProtoTimestamp | null;
      },
      ...unknown[],
    ]
  >;
  createDatabase(input: {
    parent: string;
    databaseId: string;
    database: {
      locationId: string;
      type: 'FIRESTORE_NATIVE';
      databaseEdition: 'STANDARD';
      pointInTimeRecoveryEnablement?: 'POINT_IN_TIME_RECOVERY_ENABLED';
    };
  }): Promise<[LongRunningOperation<{ createTime?: ProtoTimestamp | null }>, ...unknown[]]>;
  exportDocuments(input: {
    name: string;
    outputUriPrefix: string;
    snapshotTime: { seconds: number; nanos: number };
  }): Promise<[LongRunningOperation<{ outputUriPrefix?: string | null }>, ...unknown[]]>;
  importDocuments(input: {
    name: string;
    inputUriPrefix: string;
  }): Promise<[LongRunningOperation<unknown>, ...unknown[]]>;
};

function databaseName(identity: FirestoreIdentity): string {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(identity.projectId))
    throw new Error('Explicit Google project ID required');
  if (!identity.databaseId || identity.databaseId.includes('/'))
    throw new Error('Explicit Firestore database ID required');
  if (!identity.installationId) throw new Error('Explicit installation ID required');
  return `projects/${identity.projectId}/databases/${identity.databaseId}`;
}
function gcsPrefix(value: string): string {
  if (!/^gs:\/\/[^/]+\/.+[^/]$/.test(value) || value.includes('..'))
    throw new Error('Explicit GCS output prefix required');
  return value;
}
function timestamp(date: Date): { seconds: number; nanos: number } {
  if (!Number.isFinite(date.getTime())) throw new Error('A valid snapshot time is required');
  return {
    seconds: Math.floor(date.getTime() / 1000),
    nanos: date.getUTCMilliseconds() * 1_000_000,
  };
}
function timestampIso(value: ProtoTimestamp | null | undefined): string {
  const seconds = Number(value?.seconds);
  const nanos = value?.nanos;
  if (
    !Number.isSafeInteger(seconds) ||
    typeof nanos !== 'number' ||
    !Number.isInteger(nanos) ||
    nanos < 0 ||
    nanos >= 1e9
  )
    throw new Error('Managed operation did not return a valid completion timestamp');
  const wholeSeconds = new Date(seconds * 1000).toISOString().replace('.000Z', '');
  return nanos === 0
    ? `${wholeSeconds}Z`
    : `${wholeSeconds}.${nanos.toString().padStart(9, '0').replace(/0+$/, '')}Z`;
}
function exactTimestamp(value: Date | ProtoTimestamp): ProtoTimestamp {
  if (value instanceof Date) return timestamp(value);
  timestampIso(value);
  return value;
}
function compareTimestamps(left: ProtoTimestamp, right: ProtoTimestamp): number {
  timestampIso(left);
  timestampIso(right);
  const seconds = Number(left.seconds) - Number(right.seconds);
  return seconds === 0 ? (left.nanos ?? 0) - (right.nanos ?? 0) : seconds;
}
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function numberText(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  if (Object.is(value, -0)) return '-0';
  return value.toString();
}
type CanonicalContext = { documentsRoot: string; externalReferences: number };
function canonicalFields(fields: Record<string, ProtoValue>, context: CanonicalContext): unknown {
  return [
    'map',
    Object.entries(fields)
      .sort(([a], [b]) => compareText(a, b))
      .map(([key, value]) => [key, canonicalValue(value, context)]),
  ];
}
function canonicalValue(value: ProtoValue, context: CanonicalContext): unknown {
  if (value.nullValue !== undefined && value.nullValue !== null) return ['null'];
  if (value.booleanValue !== undefined && value.booleanValue !== null)
    return ['boolean', value.booleanValue];
  if (value.integerValue !== undefined && value.integerValue !== null)
    return ['integer', String(value.integerValue)];
  if (typeof value.doubleValue === 'number') return ['double', numberText(value.doubleValue)];
  if (value.timestampValue !== undefined && value.timestampValue !== null)
    return [
      'timestamp',
      String(value.timestampValue?.seconds ?? 0),
      value.timestampValue?.nanos ?? 0,
    ];
  if (value.stringValue !== undefined && value.stringValue !== null)
    return ['string', value.stringValue];
  if (value.bytesValue !== undefined && value.bytesValue !== null)
    return ['bytes', Buffer.from(value.bytesValue ?? new Uint8Array()).toString('base64')];
  if (value.referenceValue !== undefined && value.referenceValue !== null) {
    const localPrefix = `${context.documentsRoot}/`;
    if (value.referenceValue.startsWith(localPrefix))
      return ['reference', 'local', value.referenceValue.slice(localPrefix.length)];
    context.externalReferences++;
    return ['reference', 'external', value.referenceValue];
  }
  if (value.geoPointValue !== undefined && value.geoPointValue !== null)
    return [
      'geo',
      numberText(value.geoPointValue?.latitude ?? 0),
      numberText(value.geoPointValue?.longitude ?? 0),
    ];
  if (value.arrayValue !== undefined && value.arrayValue !== null)
    return ['array', (value.arrayValue?.values ?? []).map((item) => canonicalValue(item, context))];
  if (value.mapValue !== undefined && value.mapValue !== null)
    return canonicalFields(value.mapValue.fields ?? {}, context);
  throw new Error('Unsupported raw Firestore value in backup inventory');
}

export async function inventoryFirestoreDatabase(
  db: ManagedFirestoreRawClient,
  identity: Pick<FirestoreIdentity, 'projectId' | 'databaseId'>,
  readTime: Date | ProtoTimestamp,
): Promise<DatabaseInventory> {
  const root = `projects/${identity.projectId}/databases/${identity.databaseId}/documents`;
  const exactReadTime = exactTimestamp(readTime);
  const records: Array<{ path: string; hash: string }> = [];
  const canonicalContext: CanonicalContext = { documentsRoot: root, externalReferences: 0 };
  const collections = new Map<string, number>();
  const visited = new Set<string>();
  const visit = async (parent: string): Promise<string[]> => {
    const descendants: string[] = [];
    const [ids] = await db.listCollectionIds({ parent, readTime: exactReadTime });
    for (const collectionId of [...ids].sort()) {
      const [documents] = await db.listDocuments({
        parent,
        collectionId,
        readTime: exactReadTime,
        showMissing: true,
      });
      const ambiguous = documents.filter(
        (document) => document.createTime == null && document.updateTime == null,
      );
      const presentNames =
        ambiguous.length === 0
          ? new Set<string>()
          : new Set(
              (
                await db.listDocuments({
                  parent,
                  collectionId,
                  readTime: exactReadTime,
                  showMissing: false,
                })
              )[0].flatMap((document) => (document.name ? [document.name] : [])),
            );
      for (const document of documents) {
        if (!document.name) throw new Error('Firestore API returned a document without a name');
        const prefix = `${root}/`;
        if (!document.name.startsWith(prefix))
          throw new Error('Firestore API returned a document outside the requested database');
        const path = document.name.slice(prefix.length);
        // Missing ancestors are traversed but do not represent persisted documents.
        if (
          document.createTime != null ||
          document.updateTime != null ||
          presentNames.has(document.name)
        ) {
          const hash = createHash('sha256')
            .update(JSON.stringify(canonicalFields(document.fields ?? {}, canonicalContext)))
            .digest('hex');
          records.push({ path, hash });
          const collectionPath = path.split('/').slice(0, -1).join('/');
          collections.set(collectionPath, (collections.get(collectionPath) ?? 0) + 1);
        }
        descendants.push(document.name);
      }
    }
    return descendants;
  };
  const queue = [root];
  while (queue.length) {
    const batch: string[] = [];
    while (batch.length < 16 && queue.length) {
      const parent = queue.shift();
      if (!parent) break;
      if (!visited.has(parent)) {
        visited.add(parent);
        batch.push(parent);
      }
    }
    const discovered = await Promise.all(batch.map(visit));
    for (const parent of discovered.flat()) if (!visited.has(parent)) queue.push(parent);
  }
  records.sort((a, b) => compareText(a.path, b.path));
  const installationRoots = new Set<string>();
  let outOfScopeDocuments = 0;
  for (const record of records) {
    const parts = record.path.split('/');
    if (parts[0] === 'installations' && parts[1])
      installationRoots.add(`installations/${parts[1]}`);
    else outOfScopeDocuments++;
  }
  return {
    documents: records.length,
    collections: Object.fromEntries([...collections].sort(([a], [b]) => compareText(a, b))),
    installationRoots: [...installationRoots].sort(),
    outOfScopeDocuments,
    externalReferences: canonicalContext.externalReferences,
    canonicalHash: createHash('sha256')
      .update(records.map((record) => `${record.path}\0${record.hash}`).join('\n'))
      .digest('hex'),
  };
}

function verifiedObjects(objects: VerifiedGcsObject[], prefix: string): VerifiedGcsObject[] {
  if (!objects.length) throw new Error('Managed export did not produce any verified objects');
  const sorted = [...objects].sort((a, b) => compareText(a.uri, b.uri));
  const seen = new Set<string>();
  for (const object of sorted) {
    if (
      !object.uri.startsWith(`${prefix}/`) ||
      !object.generation ||
      !object.size ||
      !object.crc32c ||
      seen.has(object.uri)
    )
      throw new Error('Managed export object inventory is incomplete or inconsistent');
    seen.add(object.uri);
  }
  return sorted;
}

function validIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function assertRestoreManifestShape(manifest: ManagedBackupManifest): void {
  const snapshot = new Date(manifest.export?.snapshotTime);
  const collections = manifest.inventory?.collections;
  const collectionEntries =
    collections && typeof collections === 'object' && !Array.isArray(collections)
      ? Object.entries(collections)
      : [];
  if (
    !validIsoTimestamp(manifest.createdAt) ||
    !validIsoTimestamp(manifest.export?.snapshotTime) ||
    snapshot.getUTCSeconds() !== 0 ||
    snapshot.getUTCMilliseconds() !== 0 ||
    !Array.isArray(manifest.export?.objects) ||
    !Number.isSafeInteger(manifest.inventory?.documents) ||
    manifest.inventory.documents < 1 ||
    !Number.isSafeInteger(manifest.inventory?.outOfScopeDocuments) ||
    manifest.inventory.outOfScopeDocuments !== 0 ||
    !Number.isSafeInteger(manifest.inventory?.externalReferences) ||
    manifest.inventory.externalReferences !== 0 ||
    !/^[0-9a-f]{64}$/.test(manifest.inventory?.canonicalHash ?? '') ||
    !collections ||
    typeof collections !== 'object' ||
    Array.isArray(collections) ||
    collectionEntries.length === 0 ||
    collectionEntries.some(
      ([path, count]) => path.length === 0 || !Number.isSafeInteger(count) || count < 1,
    ) ||
    collectionEntries.reduce((sum, [, count]) => sum + count, 0) !== manifest.inventory.documents ||
    !Array.isArray(manifest.inventory?.installationRoots) ||
    manifest.inventory.installationRoots.some((root) => typeof root !== 'string')
  )
    throw new Error('Managed backup manifest has invalid inventory or timestamp data');
}

export async function createManagedFirestoreBackup(input: {
  admin: ManagedFirestoreAdmin;
  dataClient: ManagedFirestoreDataClient;
  source: FirestoreIdentity;
  outputUriPrefix: string;
  snapshotTime: Date;
  listObjects: (prefix: string) => Promise<VerifiedGcsObject[]>;
  now?: () => Date;
}): Promise<ManagedBackupManifest> {
  if (process.env.FIRESTORE_EMULATOR_HOST)
    throw new Error('Managed Firestore backup refuses emulator routing');
  const name = databaseName(input.source);
  if (
    input.dataClient.projectId !== input.source.projectId ||
    input.dataClient.databaseId !== input.source.databaseId
  )
    throw new Error('Firestore data client identity does not match backup source');
  const requestedOutputUriPrefix = gcsPrefix(input.outputUriPrefix);
  const now = (input.now ?? (() => new Date()))();
  if (
    !Number.isFinite(input.snapshotTime.getTime()) ||
    input.snapshotTime.getUTCSeconds() !== 0 ||
    input.snapshotTime.getUTCMilliseconds() !== 0 ||
    input.snapshotTime >= now ||
    now.getTime() - input.snapshotTime.getTime() > 15 * 60_000
  )
    throw new Error('Snapshot time must be a recent past UTC minute');
  const requestedSnapshotTime = timestamp(input.snapshotTime);
  const [database] = await input.admin.getDatabase({ name });
  if (
    database.pointInTimeRecoveryEnablement !== 'POINT_IN_TIME_RECOVERY_ENABLED' &&
    database.pointInTimeRecoveryEnablement !== 1
  )
    throw new Error('Point-in-Time Recovery must be enabled before a snapshot export');
  if (
    !database.earliestVersionTime ||
    compareTimestamps(requestedSnapshotTime, database.earliestVersionTime) < 0
  )
    throw new Error('Snapshot time predates the database earliest PITR version');
  const inventory = await inventoryFirestoreDatabase(
    input.dataClient.db,
    input.source,
    input.snapshotTime,
  );
  const installationRoot = `installations/${documentKey(input.source.installationId)}`;
  if (inventory.documents < 1)
    throw new Error('Source Firestore database is empty; refusing meaningless backup');
  if (
    inventory.outOfScopeDocuments ||
    inventory.installationRoots.length !== 1 ||
    inventory.installationRoots[0] !== installationRoot
  )
    throw new Error('Source Firestore database is not isolated to the requested installation');
  if (inventory.externalReferences !== 0)
    throw new Error(
      'Source Firestore database contains external native document references that managed import cannot preserve',
    );
  const [operation] = await input.admin.exportDocuments({
    name,
    outputUriPrefix: requestedOutputUriPrefix,
    snapshotTime: requestedSnapshotTime,
  });
  const [response] = await operation.promise();
  const outputUriPrefix = response.outputUriPrefix;
  if (
    !outputUriPrefix ||
    (outputUriPrefix !== requestedOutputUriPrefix &&
      !outputUriPrefix.startsWith(`${requestedOutputUriPrefix}/`))
  )
    throw new Error('Managed export completed outside the requested GCS prefix');
  const folder = outputUriPrefix.slice(outputUriPrefix.lastIndexOf('/') + 1);
  const metadataObjectUri = `${outputUriPrefix}/${folder}.overall_export_metadata`;
  const objects = verifiedObjects(await input.listObjects(outputUriPrefix), outputUriPrefix);
  if (!objects.some((object) => object.uri === metadataObjectUri))
    throw new Error('Managed export metadata object is absent from the object inventory');
  return {
    format: 'assistant-firestore-managed-backup',
    formatVersion: 2,
    createdAt: now.toISOString(),
    source: { ...input.source, databaseName: name, installationRoot },
    export: {
      snapshotTime: input.snapshotTime.toISOString(),
      requestedOutputUriPrefix,
      outputUriPrefix,
      metadataObjectUri,
      objects,
      operationName: operation.name ?? 'completed-operation',
      completed: true,
    },
    inventory,
  };
}

export async function restoreManagedFirestoreBackup(input: {
  admin: ManagedFirestoreAdmin;
  dataClient: ManagedFirestoreDataClient;
  target: FirestoreIdentity;
  manifest: ManagedBackupManifest;
  location: string;
  listObjects: (prefix: string) => Promise<VerifiedGcsObject[]>;
}): Promise<{
  operationName: string;
  completed: true;
  verificationReadTime: string;
  inventory: DatabaseInventory;
}> {
  if (process.env.FIRESTORE_EMULATOR_HOST)
    throw new Error('Managed Firestore restore refuses emulator routing');
  const manifest = input.manifest;
  if (
    manifest.format !== 'assistant-firestore-managed-backup' ||
    manifest.formatVersion !== 2 ||
    !manifest.export.completed
  )
    throw new Error('Invalid or incomplete managed backup manifest');
  assertRestoreManifestShape(manifest);
  const expectedName = databaseName(manifest.source);
  const expectedRoot = `installations/${documentKey(manifest.source.installationId)}`;
  const expectedMetadata = `${manifest.export.outputUriPrefix}/${manifest.export.outputUriPrefix.slice(
    manifest.export.outputUriPrefix.lastIndexOf('/') + 1,
  )}.overall_export_metadata`;
  const objects = verifiedObjects(manifest.export.objects, manifest.export.outputUriPrefix);
  if (
    manifest.source.databaseName !== expectedName ||
    manifest.source.installationRoot !== expectedRoot ||
    manifest.inventory.documents < 1 ||
    manifest.inventory.outOfScopeDocuments ||
    manifest.inventory.installationRoots.length !== 1 ||
    manifest.inventory.installationRoots[0] !== expectedRoot ||
    manifest.export.metadataObjectUri !== expectedMetadata ||
    !objects.some((object) => object.uri === expectedMetadata)
  )
    throw new Error('Managed backup manifest identity or inventory is inconsistent');
  const name = databaseName(input.target);
  if (
    input.dataClient.projectId !== input.target.projectId ||
    input.dataClient.databaseId !== input.target.databaseId
  )
    throw new Error('Firestore data client identity does not match restore target');
  if (name === manifest.source.databaseName)
    throw new Error('Restore target must be an isolated database');
  if (!/^assistant-restore-[a-z0-9-]{8,}$/.test(input.target.databaseId))
    throw new Error('Restore target must use a dedicated assistant-restore database ID');
  if (input.target.installationId !== manifest.source.installationId)
    throw new Error('Restore installation identity does not match backup');
  const currentObjects = verifiedObjects(
    await input.listObjects(manifest.export.outputUriPrefix),
    manifest.export.outputUriPrefix,
  );
  if (JSON.stringify(currentObjects) !== JSON.stringify(objects))
    throw new Error('Backup objects no longer match their manifest');
  if (!/^[a-z]+(?:-[a-z0-9]+)+$/.test(input.location))
    throw new Error('Explicit Firestore restore location required');
  const [createOperation] = await input.admin.createDatabase({
    parent: `projects/${input.target.projectId}`,
    databaseId: input.target.databaseId,
    database: { locationId: input.location, type: 'FIRESTORE_NATIVE', databaseEdition: 'STANDARD' },
  });
  const [createdDatabase] = await createOperation.promise();
  const empty = await inventoryFirestoreDatabase(
    input.dataClient.db,
    input.target,
    exactTimestamp(createdDatabase.createTime ?? {}),
  );
  if (empty.documents) throw new Error('Restore target database is not empty');
  const [operation] = await input.admin.importDocuments({
    name,
    inputUriPrefix: manifest.export.outputUriPrefix,
  });
  const [, importMetadata] = await operation.promise();
  const verificationReadTime = timestampIso(importMetadata?.endTime);
  const restored = await inventoryFirestoreDatabase(
    input.dataClient.db,
    input.target,
    exactTimestamp(importMetadata?.endTime ?? {}),
  );
  if (
    restored.documents !== manifest.inventory.documents ||
    restored.canonicalHash !== manifest.inventory.canonicalHash ||
    JSON.stringify(restored.collections) !== JSON.stringify(manifest.inventory.collections) ||
    JSON.stringify(restored.installationRoots) !==
      JSON.stringify(manifest.inventory.installationRoots) ||
    restored.outOfScopeDocuments !== manifest.inventory.outOfScopeDocuments
  )
    throw new Error('Restored Firestore database does not match backup inventory');
  const finalObjects = verifiedObjects(
    await input.listObjects(manifest.export.outputUriPrefix),
    manifest.export.outputUriPrefix,
  );
  if (JSON.stringify(finalObjects) !== JSON.stringify(objects))
    throw new Error('Backup objects changed while the restore was running');
  return {
    operationName: operation.name ?? 'completed-operation',
    completed: true,
    verificationReadTime,
    inventory: restored,
  };
}
