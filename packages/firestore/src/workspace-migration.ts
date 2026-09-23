import { createHash } from 'node:crypto';
import {
  checksumForMigrationVersion,
  deserializeMigrationValue,
  deterministicMigrationCompare,
  type MigrationBundle,
  type MigrationRecord,
  type MigrationTarget,
  PreciseMigrationTimestamp,
  tableDefinition,
  validateMigrationBundle,
} from '@assistant/persistence';
import { FieldValue, Timestamp } from '@google-cloud/firestore';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

export type WorkspaceImportMode = 'preview' | 'write' | 'verify';
export type WorkspaceImportResult = {
  mode: WorkspaceImportMode;
  records: number;
  derivedMetadata: number;
  writes: number;
  collections: Record<string, number>;
  resumed?: boolean;
  verified?: boolean;
};

export type WorkspaceActivationEvidence = {
  /** Operator-recorded identifier for the external PostgreSQL write fence. */
  sourceWriteFenceId: string;
  /** UTC timestamp at which the operator confirmed source writers had drained. */
  sourceWritesDrainedAt: string;
  snapshotUri: string;
  snapshotGeneration: string;
  snapshotSha256: string;
};

export type WorkspaceActivationResult = {
  activated: true;
  alreadyActivated: boolean;
  bundleChecksum: string;
};

function preciseTimestamp(timestamp: Timestamp): PreciseMigrationTimestamp {
  if (timestamp.nanoseconds % 1_000 !== 0)
    throw new Error('Unexpected sub-microsecond migration timestamp');
  const second = new Date(timestamp.seconds * 1000).toISOString().slice(0, 19);
  const microseconds = Math.trunc(timestamp.nanoseconds / 1_000)
    .toString()
    .padStart(6, '0');
  return new PreciseMigrationTimestamp(
    BigInt(timestamp.seconds),
    timestamp.nanoseconds,
    `${second}.${microseconds}Z`,
  );
}

function preserveTimestampPrecision(value: unknown): unknown {
  if (value instanceof Timestamp) return preciseTimestamp(value);
  if (value instanceof Date && !(value instanceof PreciseMigrationTimestamp))
    return preciseTimestamp(Timestamp.fromDate(value));
  if (Array.isArray(value)) return value.map(preserveTimestampPrecision);
  if (value && value.constructor === Object)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, preserveTimestampPrecision(item)]),
    );
  return value;
}

function decodeMigrationDocument(value: unknown): unknown {
  return decodeRecord(preserveTimestampPrecision(value));
}

function materializeValue(value: unknown): unknown {
  if (value instanceof PreciseMigrationTimestamp)
    return new Timestamp(Number(value.seconds), value.nanoseconds);
  if (Array.isArray(value)) return value.map(materializeValue);
  if (value && value.constructor === Object)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, materializeValue(item)]),
    );
  return value;
}

function markerFormatVersionMatches(
  markerFormatVersion: unknown,
  bundleFormatVersion: MigrationBundle['manifest']['formatVersion'],
): boolean {
  if (markerFormatVersion === bundleFormatVersion) return true;
  return markerFormatVersion === undefined && bundleFormatVersion <= 2;
}

async function verifyDestination(
  store: InstallationStore,
  writes: Array<{ collection: string; id: string; data: FirebaseFirestore.DocumentData }>,
  expectedChecksums: Map<string, string>,
  collections: Record<string, number>,
  bundle: MigrationBundle,
): Promise<void> {
  const marker = await store.doc('coordination', 'migration').get();
  if (
    !marker.exists ||
    !['pending_activation', 'active'].includes(marker.get('status')) ||
    marker.get('bundleChecksum') !== bundle.manifest.bundleChecksum ||
    !markerFormatVersionMatches(marker.get('formatVersion'), bundle.manifest.formatVersion) ||
    marker.get('sourceAgentId') !== bundle.manifest.source.agentId ||
    JSON.stringify(marker.get('target')) !== JSON.stringify(bundle.manifest.target) ||
    marker.get('completedWrites') !== writes.length ||
    marker.get('totalWrites') !== writes.length
  )
    throw new Error('Migration marker does not prove a complete import for this bundle');
  const actualCollectionNames = (await store.root.listCollections())
    .map((collection) => collection.id)
    .sort();
  const expectedCollectionNames = Object.keys(collections).sort();
  if (JSON.stringify(actualCollectionNames) !== JSON.stringify(expectedCollectionNames))
    throw new Error('Imported installation contains unexpected or missing collections');
  for (let index = 0; index < writes.length; index += 100) {
    const chunk = writes.slice(index, index + 100);
    const snapshots = await Promise.all(
      chunk.map((write) => store.doc(write.collection, write.id).get()),
    );
    for (let offset = 0; offset < chunk.length; offset++) {
      const write = chunk[offset];
      const snapshot = snapshots[offset];
      if (!write || !snapshot?.exists) throw new Error('Imported destination record is missing');
      if (
        checksumForMigrationVersion(
          decodeMigrationDocument(snapshot.data()),
          bundle.manifest.formatVersion,
        ) !== expectedChecksums.get(`${write.collection}:${write.id}`)
      )
        throw new Error(`Imported destination checksum mismatch: ${write.collection}/${write.id}`);
    }
  }
  for (const [collection, count] of Object.entries(collections)) {
    const snapshot = await store.collection(collection).count().get();
    const expected = count + (collection === 'coordination' ? 1 : 0);
    if (snapshot.data().count !== expected)
      throw new Error(
        `Imported collection count mismatch: ${collection} expected ${expected}, found ${snapshot.data().count}`,
      );
  }
}

function scheduleNameKey(agentId: string, name: string): string {
  return createHash('sha256')
    .update(JSON.stringify([agentId, name]))
    .digest('hex');
}

function embeddingSpaceKey(
  space: NonNullable<MigrationBundle['manifest']['source']['embeddingSpace']>,
) {
  return createHash('sha256')
    .update(JSON.stringify([space.provider, space.model, space.dimensions, space.revision]))
    .digest('hex');
}

function materialize(
  record: MigrationRecord,
  space?: MigrationBundle['manifest']['source']['embeddingSpace'],
): Record<string, unknown> {
  const data = Object.fromEntries(
    Object.entries(record.data).map(([key, value]) => [key, deserializeMigrationValue(value)]),
  );
  const vector = record.data.embedding as { $assistantMigration?: unknown } | undefined;
  if (
    vector &&
    Array.isArray(vector.$assistantMigration) &&
    vector.$assistantMigration[0] === 'vector'
  ) {
    if (!space) throw new Error(`Vector provenance is missing for ${record.table}/${record.id}`);
    const values = vector.$assistantMigration[1];
    if (!Array.isArray(values) || values.length !== space.dimensions)
      throw new Error(`Vector dimensions do not match provenance for ${record.table}/${record.id}`);
    data.embedding = FieldValue.vector(values as number[]);
    data.embeddingSpace = embeddingSpaceKey(space);
    if (record.table === 'memories' || record.table === 'skills')
      data.retrievalRevision = record.checksum;
  }
  if (record.table === 'cost_reservations') {
    data.fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          data.source,
          usdMicros(data.estimatedUsd),
          data.taskId ?? null,
          data.description ?? '',
        ]),
      )
      .digest('hex');
  }
  if (record.table === 'conversations') data.archived = Boolean(data.archivedAt);
  if (record.table === 'messages' && data.hiddenAt === undefined) data.hiddenAt = null;
  return data;
}

function projectRecord(
  record: MigrationRecord,
  bundle: MigrationBundle,
  memoryProjections: ReadonlyMap<string, Record<string, unknown>>,
): Record<string, unknown> {
  const data =
    (record.table === 'memories' && memoryProjections.get(record.id)) ||
    materialize(record, bundle.manifest.source.embeddingSpace);
  if (bundle.manifest.formatVersion >= 3 && record.table === 'knowledge_graph_sources') {
    const memoryId = data.memoryId;
    const memory = typeof memoryId === 'string' ? memoryProjections.get(memoryId) : undefined;
    const agentId = memory?.agentId;
    if (typeof agentId !== 'string' || !agentId)
      throw new Error(`Knowledge graph source is missing its owned memory: ${record.id}`);
    data.agentId = agentId;
    if (typeof memory?.retrievalRevision === 'string')
      data.retrievalRevision = memory.retrievalRevision;
  }
  return data;
}

function canonical(value: unknown, compare: (left: string, right: string) => number): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item, compare));
  if (value && typeof value === 'object' && !(value instanceof Date))
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => compare(a, b))
        .map(([key, item]) => [key, canonical(item, compare)]),
    );
  return value;
}

function approvalPolicyKey(
  policy: Record<string, unknown>,
  version: MigrationBundle['manifest']['formatVersion'],
): string {
  const requested = {
    agentId: policy.agentId,
    toolName: policy.toolName,
    templateKey: policy.templateKey,
    effect: policy.effect,
    match: policy.match,
  };
  const compare =
    version >= 3
      ? deterministicMigrationCompare
      : (left: string, right: string) => left.localeCompare(right);
  return createHash('sha256')
    .update(JSON.stringify(canonical(requested, compare)))
    .digest('hex');
}

function usdMicros(value: unknown): number {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))
    throw new Error(`Invalid migrated USD amount: ${String(value)}`);
  const micros = Math.round(Number(value) * 1_000_000);
  if (!Number.isSafeInteger(micros)) throw new Error('Migrated USD exceeds safe precision');
  return micros;
}

function assertFirestoreShape(
  value: unknown,
  destination: string,
  depth = 0,
  insideArray = false,
): void {
  if (depth > 20) throw new Error(`Migration document exceeds Firestore depth: ${destination}`);
  if (Array.isArray(value)) {
    if (insideArray) throw new Error(`Migration document contains a nested array: ${destination}`);
    for (const item of value) assertFirestoreShape(item, destination, depth + 1, true);
    return;
  }
  if (
    value &&
    typeof value === 'object' &&
    !(value instanceof Date) &&
    !(value instanceof Timestamp) &&
    !Buffer.isBuffer(value) &&
    !(value instanceof FieldValue)
  )
    for (const item of Object.values(value))
      assertFirestoreShape(item, destination, depth + 1, false);
}

function derivedRecords(bundle: MigrationBundle, target: MigrationTarget) {
  const rows: Array<{ collection: string; id: string; data: Record<string, unknown> }> = [];
  const approvals = bundle.records
    .filter((record) => record.table === 'approvals')
    .map((record) => materialize(record, bundle.manifest.source.embeddingSpace));
  let maxApprovalNumber = 0;
  for (const approval of approvals) {
    // Match PostgreSQL's allocator: the sequence is the numeric prefix after A.
    // Historical rows include suffixless codes and multiple suffix variants for
    // the same number; the preserved full shortCode remains the collision key.
    const match = /^A([0-9]+)/.exec(String(approval.shortCode ?? ''));
    if (!match) throw new Error('Malformed historical approval code');
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number + 1) || number < 1)
      throw new Error('Unsafe historical approval code sequence');
    maxApprovalNumber = Math.max(maxApprovalNumber, number);
  }
  if (approvals.length)
    rows.push({
      collection: 'coordination',
      id: 'approval-codes',
      data: { next: maxApprovalNumber + 1 },
    });
  for (const record of bundle.records.filter((candidate) => candidate.table === 'memories')) {
    const data = materialize(record, bundle.manifest.source.embeddingSpace);
    if (typeof data.contentHash === 'string')
      rows.push({
        collection: 'memoryContentHashes',
        id: data.contentHash,
        data: { memoryId: record.id },
      });
  }
  for (const record of bundle.records.filter((candidate) => candidate.table === 'schedules')) {
    const data = materialize(record, bundle.manifest.source.embeddingSpace);
    if (typeof data.agentId === 'string' && typeof data.name === 'string')
      rows.push({
        collection: 'scheduleNames',
        id: scheduleNameKey(data.agentId, data.name),
        data: { agentId: data.agentId, name: data.name, scheduleId: record.id },
      });
  }
  for (const record of bundle.records.filter((candidate) => candidate.table === 'messages')) {
    const data = materialize(record, bundle.manifest.source.embeddingSpace);
    if (typeof data.channelMessageId === 'string')
      rows.push({
        collection: 'messageChannelIds',
        id: data.channelMessageId,
        data: { messageId: record.id, conversationId: data.conversationId },
      });
  }
  for (const record of bundle.records.filter((candidate) => candidate.table === 'tasks')) {
    const data = materialize(record, bundle.manifest.source.embeddingSpace);
    if (typeof data.externalEventId === 'string')
      rows.push({
        collection: 'taskEventKeys',
        id: createHash('sha256').update(data.externalEventId).digest('hex'),
        data: { taskId: record.id, createdAt: data.createdAt },
      });
  }
  for (const record of bundle.records.filter((candidate) => candidate.table === 'tool_calls')) {
    const data = materialize(record, bundle.manifest.source.embeddingSpace);
    if (typeof data.idempotencyKey === 'string')
      rows.push({
        collection: 'toolCallIdempotency',
        id: data.idempotencyKey,
        data: { toolCallId: record.id },
      });
  }
  for (const record of bundle.records.filter(
    (candidate) => candidate.table === 'approval_policies',
  )) {
    const data = materialize(record, bundle.manifest.source.embeddingSpace);
    rows.push({
      collection: 'approvalPolicyKeys',
      id: approvalPolicyKey(data, bundle.manifest.formatVersion),
      data: { policyId: record.id },
    });
  }
  for (const record of bundle.records.filter(
    (candidate) => candidate.table === 'generated_cards',
  )) {
    const data = materialize(record, bundle.manifest.source.embeddingSpace);
    if (typeof data.agentId === 'string' && typeof data.sourceFingerprint === 'string')
      rows.push({
        collection: 'generatedCardKeys',
        id: createHash('sha256')
          .update(JSON.stringify([data.agentId, data.sourceFingerprint]))
          .digest('hex'),
        data: {
          agentId: data.agentId,
          sourceFingerprint: data.sourceFingerprint,
          cardId: record.id,
          createdAt: data.createdAt,
        },
      });
  }
  const budgets = new Map(
    bundle.records
      .filter((record) => record.table === 'budgets')
      .map((record) => {
        const data = materialize(record, bundle.manifest.source.embeddingSpace);
        return [String(data.scope), data] as const;
      }),
  );
  const daily = budgets.get('daily');
  const monthly = budgets.get('monthly');
  if (daily || monthly) {
    if (!daily || !monthly || daily.softPct !== monthly.softPct)
      throw new Error('Daily/monthly PostgreSQL budgets cannot form one Firestore policy');
    rows.push({
      collection: 'coordination',
      id: 'budget-policy',
      data: {
        dailyLimitMicros: usdMicros(daily.limitUsd),
        monthlyLimitMicros: usdMicros(monthly.limitUsd),
        softPct: daily.softPct,
      },
    });
  }
  const heldReservations = bundle.records
    .filter((record) => record.table === 'cost_reservations')
    .map((record) => materialize(record, bundle.manifest.source.embeddingSpace))
    .filter((record) => record.status === 'held');
  rows.push({
    collection: 'coordination',
    id: 'budget-holds',
    data: {
      heldMicros: heldReservations.reduce(
        (total, reservation) => total + usdMicros(reservation.estimatedUsd),
        0,
      ),
    },
  });
  const taskHolds = new Map<string, number>();
  for (const reservation of heldReservations) {
    if (typeof reservation.taskId !== 'string') continue;
    taskHolds.set(
      reservation.taskId,
      (taskHolds.get(reservation.taskId) ?? 0) + usdMicros(reservation.estimatedUsd),
    );
  }
  for (const [taskId, heldMicros] of taskHolds)
    rows.push({ collection: 'taskBudgetHolds', id: taskId, data: { heldMicros } });
  const periodTotals = new Map<string, number>();
  for (const record of bundle.records.filter((candidate) => candidate.table === 'cost_events')) {
    const data = materialize(record, bundle.manifest.source.embeddingSpace);
    if (!(data.createdAt instanceof Date)) throw new Error('Cost event has no timestamp');
    for (const id of [
      `day:${data.createdAt.toISOString().slice(0, 10)}`,
      `month:${data.createdAt.toISOString().slice(0, 7)}`,
    ])
      periodTotals.set(id, (periodTotals.get(id) ?? 0) + usdMicros(data.usd));
  }
  const exportedAt = bundle.manifest.source.exportedAt
    ? new Date(bundle.manifest.source.exportedAt)
    : null;
  if (exportedAt && Number.isFinite(exportedAt.getTime())) {
    periodTotals.set(
      `day:${exportedAt.toISOString().slice(0, 10)}`,
      periodTotals.get(`day:${exportedAt.toISOString().slice(0, 10)}`) ?? 0,
    );
    periodTotals.set(
      `month:${exportedAt.toISOString().slice(0, 7)}`,
      periodTotals.get(`month:${exportedAt.toISOString().slice(0, 7)}`) ?? 0,
    );
  }
  for (const [id, spentMicros] of periodTotals)
    rows.push({ collection: 'budgetPeriods', id, data: { spentMicros } });
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
  const recordCompare =
    bundle.manifest.formatVersion >= 3
      ? deterministicMigrationCompare
      : (left: string, right: string) => left.localeCompare(right);
  const records = [...bundle.records].sort((a, b) =>
    recordCompare(`${a.collection}:${a.id}`, `${b.collection}:${b.id}`),
  );
  const memoryProjections = new Map(
    records
      .filter((record) => record.table === 'memories')
      .map(
        (record) =>
          [record.id, materialize(record, bundle.manifest.source.embeddingSpace)] as const,
      ),
  );
  const derived = derivedRecords(bundle, options.target);
  const dataDerived = derived.filter(
    (record) => !(record.collection === 'coordination' && record.id === 'migration'),
  );
  const writes = [
    ...records.map((record) => ({
      collection: record.collection,
      id: record.id,
      data: encodeRecord(
        materializeValue(projectRecord(record, bundle, memoryProjections)) as Record<
          string,
          unknown
        >,
      ),
    })),
    ...dataDerived.map((record) => ({
      collection: record.collection,
      id: record.id,
      data: encodeRecord(materializeValue(record.data) as Record<string, unknown>),
    })),
  ];
  const writeKeys = new Set<string>();
  for (const write of writes) {
    const key = `${write.collection}:${write.id}`;
    if (writeKeys.has(key)) throw new Error(`Migration produces duplicate destination: ${key}`);
    writeKeys.add(key);
    assertFirestoreShape(write.data, `${write.collection}/${write.id}`);
    const estimatedBytes = Buffer.byteLength(
      JSON.stringify(write.data, (_key, value) =>
        typeof value === 'bigint' ? { $bigint: value.toString() } : value,
      ),
      'utf8',
    );
    if (estimatedBytes > 900_000)
      throw new Error(
        `Migration document exceeds safe Firestore inline size: ${write.collection}/${write.id} (${estimatedBytes} bytes)`,
      );
  }
  const expectedChecksums = new Map(
    writes.map((write) => [
      `${write.collection}:${write.id}`,
      checksumForMigrationVersion(
        decodeMigrationDocument(write.data),
        bundle.manifest.formatVersion,
      ),
    ]),
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
  if (mode === 'verify') {
    await verifyDestination(store, writes, expectedChecksums, collections, bundle);
    return {
      mode,
      records: records.length,
      derivedMetadata: derived.length,
      writes: writes.length + 1,
      collections,
      verified: true,
    };
  }
  const markerIdentity = {
    sourceAgentId: bundle.manifest.source.agentId,
    target: options.target,
    bundleChecksum: bundle.manifest.bundleChecksum,
    formatVersion: bundle.manifest.formatVersion,
  };
  let resumed = false;
  let completed = 0;
  if (markerData) {
    if (
      markerData.bundleChecksum !== markerIdentity.bundleChecksum ||
      !markerFormatVersionMatches(markerData.formatVersion, markerIdentity.formatVersion) ||
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
          checksumForMigrationVersion(
            decodeMigrationDocument(snapshot.data()),
            bundle.manifest.formatVersion,
          ) !== expectedChecksum
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
        formatVersion: bundle.manifest.formatVersion,
        status: index + chunk.length === writes.length ? 'pending_activation' : 'importing',
      });
    });
    batchCount += 1;
    if (options.failAfterBatches && batchCount >= options.failAfterBatches)
      throw new Error('Injected migration batch failure');
  }
  await verifyDestination(store, writes, expectedChecksums, collections, bundle);
  return {
    mode,
    records: records.length,
    derivedMetadata: derived.length,
    writes: writes.length + 1,
    collections,
    resumed,
    verified: true,
  };
}

/**
 * Activate only a fully verified v3 bundle after the operator supplies the
 * final source-write-fence attestation and the identity of the pinned snapshot.
 * The transaction is the single-winner fence; repeated identical requests are
 * idempotent, while any conflicting marker or evidence fails closed.
 */
export async function activateWorkspaceBundle(
  store: InstallationStore,
  bundle: MigrationBundle,
  input: {
    sourceAgentId: string;
    target: MigrationTarget;
    evidence: WorkspaceActivationEvidence;
    snapshotBytes: Uint8Array;
  },
): Promise<WorkspaceActivationResult> {
  validateMigrationBundle(bundle, { sourceAgentId: input.sourceAgentId, target: input.target });
  if (
    bundle.manifest.formatVersion !== 3 ||
    bundle.manifest.coverage.complete !== true ||
    bundle.manifest.coverage.omittedTables.length !== 0
  )
    throw new Error('Activation requires a complete version 3 migration bundle');
  if (store.installationId !== input.target.installationId)
    throw new Error('Firestore installation identity does not match migration target');
  if (store.projectId && store.projectId !== input.target.projectId)
    throw new Error('Firestore project identity does not match migration target');
  if (store.databaseId !== input.target.databaseId)
    throw new Error('Firestore database identity does not match migration target');

  const { evidence } = input;
  const drainedAt = new Date(evidence.sourceWritesDrainedAt);
  if (!evidence.sourceWriteFenceId.trim() || evidence.sourceWriteFenceId.length > 200)
    throw new Error('A source write-fence identifier is required');
  if (
    !Number.isFinite(drainedAt.getTime()) ||
    drainedAt.toISOString() !== evidence.sourceWritesDrainedAt
  )
    throw new Error('Source drain time must be a canonical UTC timestamp');
  const exportDrainBoundary = `${drainedAt.toISOString().slice(0, -1)}000Z`;
  if ((bundle.manifest.source.exportedAt ?? '') < exportDrainBoundary)
    throw new Error('Pinned snapshot was exported before the recorded source drain');
  const snapshotPath = /^gs:\/\/([^/]+)\/(.+)$/.exec(evidence.snapshotUri);
  if (
    snapshotPath?.[1] !== `${input.target.projectId}-workspace` ||
    !snapshotPath[2]?.startsWith(`workspace/${input.target.installationId}/migration/snapshots/`) ||
    !snapshotPath[2]?.endsWith('.json')
  )
    throw new Error('Snapshot URI must identify this installation workspace export');
  if (!/^[1-9]\d*$/.test(evidence.snapshotGeneration))
    throw new Error('Snapshot generation must be a positive integer');
  const snapshotSha256 = createHash('sha256').update(input.snapshotBytes).digest('hex');
  if (
    !/^[0-9a-f]{64}$/i.test(evidence.snapshotSha256) ||
    snapshotSha256 !== evidence.snapshotSha256.toLowerCase()
  )
    throw new Error('Snapshot bytes do not match the supplied SHA-256');
  let pinnedBundle: MigrationBundle;
  try {
    pinnedBundle = JSON.parse(Buffer.from(input.snapshotBytes).toString('utf8')) as MigrationBundle;
  } catch {
    throw new Error('Pinned snapshot is not valid JSON');
  }
  if (pinnedBundle.manifest?.bundleChecksum !== bundle.manifest.bundleChecksum)
    throw new Error('Pinned snapshot does not match the bundle being activated');
  validateMigrationBundle(pinnedBundle, {
    sourceAgentId: input.sourceAgentId,
    target: input.target,
  });

  // This rereads and checks every imported record and collection count. Tasks
  // and schedules remain gated until the transaction below changes the marker.
  await importWorkspaceBundle(store, bundle, {
    sourceAgentId: input.sourceAgentId,
    target: input.target,
    mode: 'verify',
  });

  const marker = store.doc('coordination', 'migration');
  const activation = {
    sourceWriteFenceId: evidence.sourceWriteFenceId,
    sourceWritesDrainedAt: drainedAt,
    snapshotUri: evidence.snapshotUri,
    snapshotGeneration: evidence.snapshotGeneration,
    snapshotSha256,
  };
  return store.db.runTransaction(async (tx) => {
    const current = await tx.get(marker);
    if (!current.exists) throw new Error('Migration marker disappeared before activation');
    const currentChecksum = current.get('bundleChecksum');
    if (
      currentChecksum !== bundle.manifest.bundleChecksum ||
      current.get('sourceAgentId') !== input.sourceAgentId ||
      JSON.stringify(current.get('target')) !== JSON.stringify(input.target)
    )
      throw new Error('Migration marker belongs to a different bundle or identity');
    if (current.get('status') === 'active') {
      const prior = current.get('activation') as Record<string, unknown> | undefined;
      const priorDrainedAt = prior?.sourceWritesDrainedAt;
      const sameEvidence =
        prior?.sourceWriteFenceId === activation.sourceWriteFenceId &&
        (priorDrainedAt instanceof Timestamp
          ? priorDrainedAt.toDate().toISOString()
          : priorDrainedAt instanceof Date
            ? priorDrainedAt.toISOString()
            : null) === drainedAt.toISOString() &&
        prior?.snapshotUri === activation.snapshotUri &&
        prior?.snapshotGeneration === activation.snapshotGeneration &&
        prior?.snapshotSha256 === activation.snapshotSha256;
      if (!sameEvidence)
        throw new Error('Migration was already activated with conflicting cutover evidence');
      return {
        activated: true,
        alreadyActivated: true,
        bundleChecksum: bundle.manifest.bundleChecksum,
      };
    }
    if (
      current.get('status') !== 'pending_activation' ||
      current.get('completedWrites') !== current.get('totalWrites') ||
      !Number.isSafeInteger(current.get('totalWrites'))
    )
      throw new Error('Migration marker does not prove a complete pending import');
    tx.update(marker, {
      status: 'active',
      activation: encodeRecord(activation),
    });
    return {
      activated: true,
      alreadyActivated: false,
      bundleChecksum: bundle.manifest.bundleChecksum,
    };
  });
}

export function migrationCoverage(bundle: MigrationBundle): string[] {
  return [...new Set(bundle.records.map((record) => record.table))].filter(
    (table) => !tableDefinition(table),
  );
}

export { checksum } from '@assistant/persistence';
