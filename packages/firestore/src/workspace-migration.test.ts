import { createHash, randomUUID } from 'node:crypto';
import {
  checksum,
  checksumV3,
  deterministicMigrationCompare,
  type MigrationBundle,
  type MigrationRecord,
  serializeMigrationTimestamp,
  serializeMigrationValue,
  serializeMigrationVector,
} from '@assistant/persistence';
import { Timestamp } from '@google-cloud/firestore';
import { describe, expect, it, vi } from 'vitest';
import { embeddingSpaceKey } from './memory.js';
import { FirestoreScheduleRepository } from './schedules.js';
import { decodeRecord } from './store.js';
import { FirestoreTaskLeaseRepository } from './tasks.js';
import { disposeStore, emulatorStore } from './test-store.js';
import { importWorkspaceBundle } from './workspace-migration.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

function bundle(target: MigrationBundle['manifest']['target'], taskCount = 1): MigrationBundle {
  const agentId = randomUUID();
  const agentData = {
    id: agentId,
    name: 'Imported owner',
    email: 'owner@example.test',
    workspacePrefix: 'workspace/test',
  };
  const records: MigrationRecord[] = [
    {
      table: 'agents',
      collection: 'agents',
      id: agentId,
      data: agentData,
      checksum: checksum(agentData),
    },
  ];
  for (let index = 0; index < taskCount; index++) {
    const id = randomUUID();
    const data = {
      id,
      agentId,
      type: 'adhoc',
      status: 'pending',
      trigger: {},
      state: {},
      trust: 'owner',
    };
    records.push({ table: 'tasks', collection: 'tasks', id, data, checksum: checksum(data) });
  }
  const ordered = [...records].sort((a, b) =>
    `${a.table}:${a.id}`.localeCompare(`${b.table}:${b.id}`),
  );
  return {
    manifest: {
      format: 'assistant-workspace-migration',
      formatVersion: 1,
      mode: 'export',
      source: { kind: 'postgresql', agentId, scope: 'installation', snapshot: '1-1-1' },
      target,
      tables: {
        agents: { collection: 'agents', count: 1, checksum: checksum([records[0]]) },
        tasks: {
          collection: 'tasks',
          count: taskCount,
          checksum: checksum(
            records
              .slice(1)
              .sort((a, b) => `${a.table}:${a.id}`.localeCompare(`${b.table}:${b.id}`)),
          ),
        },
      } as MigrationBundle['manifest']['tables'],
      coverage: {
        complete: false,
        supportedTables: ['agents', 'tasks'],
        omittedTables: ['remaining PostgreSQL tables'],
      },
      recordCount: records.length,
      bundleChecksum: checksum(ordered),
      unsupportedTables: [],
    },
    records,
  };
}

function addRecord(source: MigrationBundle, record: MigrationRecord): void {
  record.checksum = checksum(record.data);
  source.records.push(record);
  source.records.sort((a, b) => `${a.table}:${a.id}`.localeCompare(`${b.table}:${b.id}`));
  const records = source.records.filter((candidate) => candidate.table === record.table);
  source.manifest.tables[record.table] = {
    collection: record.collection,
    count: records.length,
    checksum: checksum(records),
  };
  source.manifest.coverage.supportedTables = Object.keys(
    source.manifest.tables,
  ) as MigrationBundle['manifest']['coverage']['supportedTables'];
  source.manifest.recordCount = source.records.length;
  source.manifest.bundleChecksum = checksum(source.records);
}

function refreshRecord(source: MigrationBundle, record: MigrationRecord): void {
  record.checksum = checksum(record.data);
  source.records.sort((a, b) => `${a.table}:${a.id}`.localeCompare(`${b.table}:${b.id}`));
  const records = source.records.filter((candidate) => candidate.table === record.table);
  const summary = source.manifest.tables[record.table];
  if (!summary) throw new Error('fixture summary missing');
  summary.checksum = checksum(records);
  source.manifest.bundleChecksum = checksum(source.records);
}

function addApproval(source: MigrationBundle, shortCode: string): void {
  const taskId = source.records.find((record) => record.table === 'tasks')?.id;
  if (!taskId) throw new Error('fixture task missing');
  const approvalId = randomUUID();
  const toolCallId = randomUUID();
  addRecord(source, {
    table: 'tool_calls',
    collection: 'toolCalls',
    id: toolCallId,
    data: { id: toolCallId, taskId, approvalId },
    checksum: '',
  });
  addRecord(source, {
    table: 'approvals',
    collection: 'approvals',
    id: approvalId,
    data: { id: approvalId, taskId, toolCallId, shortCode },
    checksum: '',
  });
}

function upgradeFixtureToV3(source: MigrationBundle): void {
  source.manifest.formatVersion = 3;
  for (const record of source.records) record.checksum = checksumV3(record.data);
  source.records.sort((left, right) =>
    deterministicMigrationCompare(`${left.table}:${left.id}`, `${right.table}:${right.id}`),
  );
  for (const [table, summary] of Object.entries(source.manifest.tables)) {
    const records = source.records.filter((record) => record.table === table);
    summary.checksum = checksumV3(records);
  }
  source.manifest.bundleChecksum = checksumV3(source.records);
}

describe('Firestore migration preview', () => {
  const target = {
    projectId: 'demo-assistant-test',
    databaseId: '(default)',
    installationId: 'preview',
  };
  const previewStore = {} as Parameters<typeof importWorkspaceBundle>[0];

  it('previews a deterministic v3 bundle with Unicode data', async () => {
    const source = bundle(target);
    const owner = source.records[0];
    if (!owner) throw new Error('fixture owner missing');
    owner.data.äther = { é: true, e: false };
    upgradeFixtureToV3(source);
    await expect(
      importWorkspaceBundle(previewStore, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
      }),
    ).resolves.toMatchObject({ mode: 'preview', records: 2 });
  });

  it('accepts historical approval suffix variants and repeated numeric prefixes', async () => {
    const source = bundle(target);
    for (const shortCode of ['A7', 'A7AA', 'A7-later-format']) addApproval(source, shortCode);

    await expect(
      importWorkspaceBundle(previewStore, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
      }),
    ).resolves.toMatchObject({ mode: 'preview', records: 8 });
  });

  it('rejects an approval code without PostgreSQL allocator digits', async () => {
    const source = bundle(target);
    addApproval(source, 'A-legacy');

    await expect(
      importWorkspaceBundle(previewStore, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
      }),
    ).rejects.toThrow('Malformed historical approval code');
  });

  it('previews nested arrays through the reversible Firestore codec', async () => {
    const source = bundle(target);
    const owner = source.records[0];
    if (!owner) throw new Error('fixture owner missing');
    owner.data.unsupported = [[1]];
    refreshRecord(source, owner);
    await expect(
      importWorkspaceBundle(previewStore, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
      }),
    ).resolves.toMatchObject({ mode: 'preview', records: 2 });
  });

  it('rejects an oversize inline document before attempting a destination write', async () => {
    const source = bundle(target);
    const owner = source.records[0];
    if (!owner) throw new Error('fixture owner missing');
    owner.data.unsupported = 'x'.repeat(900_001);
    refreshRecord(source, owner);
    await expect(
      importWorkspaceBundle(previewStore, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
      }),
    ).rejects.toThrow('exceeds safe Firestore inline size');
  });
});

describe.skipIf(!enabled)('Firestore workspace migration import', () => {
  it('derives v3 approval policy keys with runtime code-unit ordering', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target);
      const policyId = randomUUID();
      const policy = {
        id: policyId,
        agentId: source.manifest.source.agentId,
        toolName: 'unicode.tool',
        templateKey: 'unicode',
        effect: 'allow',
        match: { z: true, ä: { é: 1, e: 2 } },
      };
      addRecord(source, {
        table: 'approval_policies',
        collection: 'approvalPolicies',
        id: policyId,
        data: policy,
        checksum: '',
      });
      upgradeFixtureToV3(source);
      const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
        throw new Error('locale-dependent policy ordering used');
      });
      const result = await importWorkspaceBundle(store, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
        mode: 'write',
      });
      localeCompare.mockRestore();
      expect(result.verified).toBe(true);
      const canonical = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(canonical);
        if (value && typeof value === 'object')
          return Object.fromEntries(
            Object.entries(value)
              .filter(([, item]) => item !== undefined)
              .sort(([left], [right]) => deterministicMigrationCompare(left, right))
              .map(([key, item]) => [key, canonical(item)]),
          );
        return value;
      };
      const requested = {
        agentId: policy.agentId,
        toolName: policy.toolName,
        templateKey: policy.templateKey,
        effect: policy.effect,
        match: policy.match,
      };
      const expectedKey = createHash('sha256')
        .update(JSON.stringify(canonical(requested)))
        .digest('hex');
      expect((await store.doc('approvalPolicyKeys', expectedKey).get()).get('policyId')).toBe(
        policyId,
      );
    } finally {
      vi.restoreAllMocks();
      await disposeStore(store);
    }
  });

  it('imports without outbox work and keeps tasks gated until activation', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target);
      const owner = source.records.find((record) => record.table === 'agents');
      if (!owner) throw new Error('fixture owner missing');
      owner.data.createdAt = serializeMigrationValue(new Date('2026-09-12T12:34:56.789Z'));
      refreshRecord(source, owner);
      const preview = await importWorkspaceBundle(store, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
      });
      expect(preview.mode).toBe('preview');
      const result = await importWorkspaceBundle(store, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
        mode: 'write',
      });
      expect(result.writes).toBe(4); // agent, task, budget-holds compatibility row, marker
      expect(result.verified).toBe(true);
      const verified = await importWorkspaceBundle(store, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
        mode: 'verify',
      });
      expect(verified.verified).toBe(true);
      expect((await store.collection('outbox').get()).empty).toBe(true);
      const task = source.records.find((record) => record.table === 'tasks');
      if (!task) throw new Error('test task missing');
      expect((await store.doc('tasks', task.id).get()).get('status')).toBe('pending');
      expect(await new FirestoreTaskLeaseRepository(store).claim(task.id)).toBeNull();
      await expect(
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'write',
        }),
      ).rejects.toThrow('not empty');
    } finally {
      await disposeStore(store);
    }
  });

  it('preserves native memory vectors with explicit provenance and hash metadata', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target);
      const space = { provider: 'test', model: 'migration', dimensions: 3, revision: '1' };
      source.manifest.source.embeddingSpace = space;
      const agentId = source.manifest.source.agentId;
      const memoryId = randomUUID();
      addRecord(source, {
        table: 'memories',
        collection: 'memories',
        id: memoryId,
        data: {
          id: memoryId,
          agentId,
          contentHash: 'memory-hash',
          embedding: serializeMigrationVector([1, 0, 0]),
        },
        checksum: '',
      });
      const result = await importWorkspaceBundle(store, source, {
        sourceAgentId: agentId,
        target,
        mode: 'write',
      });
      expect(result.verified).toBe(true);
      const memory = await store.doc('memories', memoryId).get();
      expect(memory.get('embedding').toArray()).toEqual([1, 0, 0]);
      expect(memory.get('embeddingSpace')).toBe(embeddingSpaceKey(space));
      expect(memory.get('retrievalRevision')).toBe(
        source.records.find((record) => record.id === memoryId)?.checksum,
      );
      expect((await store.doc('memoryContentHashes', 'memory-hash').get()).get('memoryId')).toBe(
        memoryId,
      );
    } finally {
      await disposeStore(store);
    }
  });

  it('materializes distinct sub-millisecond timestamps as native Firestore timestamps', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target, 2);
      source.manifest.formatVersion = 2;
      const tasks = source.records.filter((record) => record.table === 'tasks');
      const first = tasks[0];
      const second = tasks[1];
      if (!first || !second) throw new Error('timestamp fixtures missing');
      first.data.createdAt = serializeMigrationTimestamp('2026-09-19 12:34:56.123456+00');
      second.data.createdAt = serializeMigrationTimestamp('2026-09-19 12:34:56.123789+00');
      refreshRecord(source, first);
      refreshRecord(source, second);
      const mailbox = 'precision@example.test';
      addRecord(source, {
        table: 'gmail_sync_state',
        collection: 'gmailSyncState',
        id: mailbox,
        data: {
          mailbox,
          lastHistoryId: serializeMigrationValue(9_223_372_036_854_775_807n),
        },
        checksum: '',
      });

      const result = await importWorkspaceBundle(store, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
        mode: 'write',
      });
      expect(result.verified).toBe(true);
      const [firstSnapshot, secondSnapshot] = await store.db.getAll(
        store.doc('tasks', first.id),
        store.doc('tasks', second.id),
      );
      if (!firstSnapshot || !secondSnapshot) throw new Error('imported timestamps missing');
      const firstTimestamp = firstSnapshot.get('createdAt') as Timestamp;
      const secondTimestamp = secondSnapshot.get('createdAt') as Timestamp;
      expect(firstTimestamp).toBeInstanceOf(Timestamp);
      expect(firstTimestamp.seconds).toBe(secondTimestamp.seconds);
      expect(firstTimestamp.nanoseconds).toBe(123_456_000);
      expect(secondTimestamp.nanoseconds).toBe(123_789_000);
      const gmail = decodeRecord<Record<string, unknown>>(
        (await store.doc('gmailSyncState', mailbox).get()).data(),
      );
      expect(gmail.lastHistoryId).toBe(9_223_372_036_854_775_807n);
      await store.doc('tasks', first.id).update({
        createdAt: new Timestamp(firstTimestamp.seconds, firstTimestamp.nanoseconds + 1_000),
      });
      await expect(
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'verify',
        }),
      ).rejects.toThrow('checksum mismatch');
    } finally {
      await disposeStore(store);
    }
  });

  it('rejects a tampered bundle before reading or writing the target', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target);
      const task = source.records.find((record) => record.table === 'tasks');
      if (!task) throw new Error('test task missing');
      task.data.status = 'done';
      await expect(
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
        }),
      ).rejects.toThrow('checksum mismatch');
      expect((await store.collection('agents').get()).empty).toBe(true);
    } finally {
      await disposeStore(store);
    }
  });

  it('resumes an interrupted multi-batch import exactly once', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target, 500);
      await expect(
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'write',
          failAfterBatches: 1,
        }),
      ).rejects.toThrow('Injected');
      const task = [...source.records]
        .filter((record) => record.table === 'tasks')
        .sort((a, b) => a.id.localeCompare(b.id))[0];
      if (!task) throw new Error('test task missing');
      expect(await new FirestoreTaskLeaseRepository(store).claim(task.id)).toBeNull();
      await store.doc('tasks', task.id).update({ status: 'done' });
      await expect(
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'write',
        }),
      ).rejects.toThrow('checksum');
      await store.doc('tasks', task.id).update({ status: 'pending' });
      const resumed = await importWorkspaceBundle(store, source, {
        sourceAgentId: source.manifest.source.agentId,
        target,
        mode: 'write',
      });
      expect(resumed.resumed).toBe(true);
      expect((await store.collection('tasks').get()).size).toBe(500);
      expect((await store.collection('outbox').get()).empty).toBe(true);
      expect((await store.doc('coordination', 'migration').get()).get('status')).toBe(
        'pending_activation',
      );
    } finally {
      await disposeStore(store);
    }
  });

  it('blocks an imported due schedule while activation is pending', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target);
      const scheduleId = randomUUID();
      await store.doc('schedules', scheduleId).set({
        id: scheduleId,
        agentId: source.manifest.source.agentId,
        name: 'imported',
        cron: '* * * * *',
        taskTemplate: {},
        enabled: true,
        nextRunAt: new Date('2020-01-01T00:00:00Z'),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await store.doc('coordination', 'migration').set({
        status: 'pending_activation',
        sourceAgentId: source.manifest.source.agentId,
        target,
        bundleChecksum: source.manifest.bundleChecksum,
      });
      const row = await new FirestoreScheduleRepository(store).listDue(
        new Date('2026-09-12T00:00:00Z'),
      );
      expect(row.some((schedule) => schedule.id === scheduleId)).toBe(true);
      const expected = row.find((schedule) => schedule.id === scheduleId);
      if (!expected) throw new Error('schedule missing');
      const result = await new FirestoreScheduleRepository(store).commitOccurrence({
        expected,
        now: new Date('2026-09-12T00:00:00Z'),
        mode: 'due',
        nextRunAt: new Date('2026-09-13T00:00:00Z'),
        enabled: true,
        task: null,
      });
      expect(result).toBeNull();
    } finally {
      await disposeStore(store);
    }
  });

  it('allows only one concurrent resume to advance the cursor', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target, 500);
      await expect(
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'write',
          failAfterBatches: 1,
        }),
      ).rejects.toThrow('Injected');
      const results = await Promise.allSettled([
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'write',
        }),
        importWorkspaceBundle(store, source, {
          sourceAgentId: source.manifest.source.agentId,
          target,
          mode: 'write',
        }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect((await store.collection('tasks').get()).size).toBe(500);
      expect((await store.doc('coordination', 'migration').get()).get('status')).toBe(
        'pending_activation',
      );
    } finally {
      await disposeStore(store);
    }
  });
});
