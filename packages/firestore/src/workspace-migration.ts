import { createHash } from 'node:crypto';
import {
  checksum,
  deserializeMigrationValue,
  type MigrationBundle,
  type MigrationRecord,
  type MigrationTarget,
  tableDefinition,
  validateMigrationBundle,
} from '@assistant/persistence';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

export type WorkspaceImportMode = 'preview' | 'write';
export type WorkspaceImportResult = {
  mode: WorkspaceImportMode;
  records: number;
  derivedMetadata: number;
  writes: number;
  collections: Record<string, number>;
  resumed?: boolean;
};

function scheduleNameKey(agentId: string, name: string): string {
  return createHash('sha256')
    .update(JSON.stringify([agentId, name]))
    .digest('hex');
}

function materialize(record: MigrationRecord): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record.data).map(([key, value]) => [key, deserializeMigrationValue(value)]),
  );
}

function derivedRecords(bundle: MigrationBundle, target: MigrationTarget) {
  const rows: Array<{ collection: string; id: string; data: Record<string, unknown> }> = [];
  const approvals = bundle.records
    .filter((record) => record.table === 'approvals')
    .map(materialize);
  let maxApprovalNumber = 0;
  const approvalNumbers = new Set<number>();
  for (const approval of approvals) {
    const match = /^A([1-9]\d*)([A-Z]{2})$/.exec(String(approval.shortCode ?? ''));
    if (!match) throw new Error('Malformed historical approval code');
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number + 1) || approvalNumbers.has(number))
      throw new Error('Duplicate or unsafe historical approval code');
    approvalNumbers.add(number);
    maxApprovalNumber = Math.max(maxApprovalNumber, number);
  }
  if (approvals.length)
    rows.push({
      collection: 'coordination',
      id: 'approval-codes',
      data: { next: maxApprovalNumber + 1 },
    });
  for (const record of bundle.records.filter((candidate) => candidate.table === 'memories')) {
    const data = materialize(record);
    if (typeof data.contentHash === 'string')
      rows.push({
        collection: 'memoryContentHashes',
        id: data.contentHash,
        data: { memoryId: record.id },
      });
  }
  for (const record of bundle.records.filter((candidate) => candidate.table === 'schedules')) {
    const data = materialize(record);
    if (typeof data.agentId === 'string' && typeof data.name === 'string')
      rows.push({
        collection: 'scheduleNames',
        id: scheduleNameKey(data.agentId, data.name),
        data: { agentId: data.agentId, name: data.name, scheduleId: record.id },
      });
  }
  rows.push({
    collection: 'coordination',
    id: 'migration',
    data: {
      status: 'pending_activation',
      sourceAgentId: bundle.manifest.source.agentId,
      target,
      bundleChecksum: bundle.manifest.bundleChecksum,
      formatVersion: bundle.manifest.formatVersion,
    },
  });
  return rows;
}

/**
 * Validate and preview/import a bundle. Writes are opt-in and use Firestore
 * create operations, so an existing installation can never be adopted or
 * overwritten. A second import of the same bundle therefore fails closed.
 */
export async function importWorkspaceBundle(
  store: InstallationStore,
  bundle: MigrationBundle,
  options: {
    sourceAgentId: string;
    target: MigrationTarget;
    mode?: WorkspaceImportMode;
    failAfterBatches?: number;
  },
): Promise<WorkspaceImportResult> {
  validateMigrationBundle(bundle, options);
  if (bundle.records.some((record) => record.table === 'memories'))
    throw new Error(
      'Memory import requires an explicit embedding-space migration plan; refusing incompatible records',
    );
  const records = [...bundle.records].sort((a, b) =>
    `${a.collection}:${a.id}`.localeCompare(`${b.collection}:${b.id}`),
  );
  const derived = derivedRecords(bundle, options.target);
  const dataDerived = derived.filter(
    (record) => !(record.collection === 'coordination' && record.id === 'migration'),
  );
  const writes = [
    ...records.map((record) => ({
      collection: record.collection,
      id: record.id,
      data: encodeRecord(materialize(record)),
    })),
    ...dataDerived.map((record) => ({
      collection: record.collection,
      id: record.id,
      data: encodeRecord(record.data),
    })),
  ];
  const expectedChecksums = new Map(
    writes.map((write) => [`${write.collection}:${write.id}`, checksum(decodeRecord(write.data))]),
  );
  const collections = Object.fromEntries(
    writes.reduce(
      (counts, write) => counts.set(write.collection, (counts.get(write.collection) ?? 0) + 1),
      new Map<string, number>(),
    ),
  );
  const mode = options.mode ?? 'preview';
  if (mode === 'preview')
    return {
      mode,
      records: records.length,
      derivedMetadata: derived.length,
      writes: writes.length + 1,
      collections,
    };
  if (store.installationId !== options.target.installationId)
    throw new Error('Firestore installation identity does not match migration target');
  if (store.projectId && store.projectId !== options.target.projectId)
    throw new Error('Firestore project identity does not match migration target');
  if (store.databaseId !== options.target.databaseId)
    throw new Error('Firestore database identity does not match migration target');
  const marker = store.doc('coordination', 'migration');
  const markerSnapshot = await marker.get();
  const markerData = markerSnapshot.exists ? markerSnapshot.data() : undefined;
  const markerIdentity = {
    sourceAgentId: bundle.manifest.source.agentId,
    target: options.target,
    bundleChecksum: bundle.manifest.bundleChecksum,
  };
  let resumed = false;
  let completed = 0;
  if (markerData) {
    if (
      markerData.bundleChecksum !== markerIdentity.bundleChecksum ||
      markerData.sourceAgentId !== markerIdentity.sourceAgentId ||
      JSON.stringify(markerData.target) !== JSON.stringify(markerIdentity.target)
    )
      throw new Error('Existing migration marker belongs to a different bundle or identity');
    if (markerData.status === 'pending_activation')
      throw new Error(
        'Target installation is not empty; migration is awaiting explicit activation',
      );
    if (markerData.status !== 'importing') throw new Error('Invalid migration marker state');
    completed = Number(markerData.completedWrites ?? 0);
    if (!Number.isSafeInteger(completed) || completed < 0 || completed > writes.length)
      throw new Error('Invalid migration progress marker');
    resumed = completed > 0;
  } else {
    const collections = await store.root.listCollections();
    const existing = await Promise.all(
      (await Promise.all(collections.map((collection) => collection.limit(1).get()))).map(
        (snapshot) => snapshot.empty,
      ),
    );
    if (existing.some((empty) => !empty))
      throw new Error('Target installation is not empty; refusing overwrite or adoption');
    const batch = store.db.batch();
    batch.create(
      marker,
      encodeRecord({
        ...markerIdentity,
        status: 'importing',
        completedWrites: 0,
        totalWrites: writes.length,
      }),
    );
    await batch.commit();
  }
  // Verify already committed prefix and refuse any stray document before it.
  for (let index = 0; index < writes.length; index += 50) {
    const chunk = writes.slice(index, Math.min(index + 50, writes.length));
    const snapshots = await Promise.all(
      chunk.map((write) => store.doc(write.collection, write.id).get()),
    );
    for (let offset = 0; offset < snapshots.length; offset++) {
      const present = snapshots[offset]?.exists;
      if (index + offset < completed && !present)
        throw new Error('Migration progress marker is missing a completed record');
      if (index + offset < completed && snapshots[offset]) {
        const expected = writes[index + offset];
        const expectedChecksum =
          expected && expectedChecksums.get(`${expected.collection}:${expected.id}`);
        const snapshot = snapshots[offset];
        if (
          expectedChecksum &&
          snapshot &&
          checksum(decodeRecord(snapshot.data())) !== expectedChecksum
        )
          throw new Error('Completed migration record checksum mismatch');
      }
      if (index + offset >= completed && present)
        throw new Error('Destination contains an unexpected migration record');
    }
  }
  let batchCount = 0;
  for (let index = completed; index < writes.length; index += 450) {
    const chunk = writes.slice(index, Math.min(index + 450, writes.length));
    await store.db.runTransaction(async (tx) => {
      const current = await tx.get(marker);
      if (
        !current.exists ||
        current.get('status') !== 'importing' ||
        current.get('completedWrites') !== index
      )
        throw new Error('Another migration import advanced the progress cursor');
      const snapshots = await tx.getAll(
        ...chunk.map((write) => store.doc(write.collection, write.id)),
      );
      if (snapshots.some((snapshot) => snapshot.exists))
        throw new Error('Destination contains an unexpected migration record');
      for (const write of chunk) tx.create(store.doc(write.collection, write.id), write.data);
      tx.update(marker, {
        completedWrites: index + chunk.length,
        status: index + chunk.length === writes.length ? 'pending_activation' : 'importing',
      });
    });
    batchCount += 1;
    if (options.failAfterBatches && batchCount >= options.failAfterBatches)
      throw new Error('Injected migration batch failure');
  }
  return {
    mode,
    records: records.length,
    derivedMetadata: derived.length,
    writes: writes.length + 1,
    collections,
    resumed,
  };
}

export function migrationCoverage(bundle: MigrationBundle): string[] {
  return [...new Set(bundle.records.map((record) => record.table))].filter(
    (table) => !tableDefinition(table),
  );
}

export { checksum };
