import { randomUUID } from 'node:crypto';
import { checksum, type MigrationBundle, type MigrationRecord } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { FirestoreScheduleRepository } from './schedules.js';
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

describe.skipIf(!enabled)('Firestore workspace migration import', () => {
  it('imports without outbox work and keeps tasks gated until activation', async () => {
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const source = bundle(target);
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
      expect(result.writes).toBe(3); // agent, task, migration marker
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
