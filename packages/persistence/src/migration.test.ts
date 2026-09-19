import { describe, expect, it, vi } from 'vitest';
import {
  assertSupportedMigrationTables,
  checksum,
  checksumForMigrationVersion,
  checksumV3,
  deserializeMigrationValue,
  type MigrationBundle,
  type MigrationRecord,
  type SerializedValue,
  serializeMigrationTimestamp,
  serializeMigrationValue,
  serializeMigrationValueV3,
  validateMigrationBundle,
  validateMigrationReferences,
} from './migration.js';

const agent = (id: string): MigrationRecord => ({
  table: 'agents',
  collection: 'agents',
  id,
  data: { id, name: 'Owner', email: 'owner@example.test', workspacePrefix: 'workspace/test' },
  checksum: checksum({
    id,
    name: 'Owner',
    email: 'owner@example.test',
    workspacePrefix: 'workspace/test',
  }),
});

describe('workspace migration format', () => {
  it('serializes dates and vectors deterministically', () => {
    expect(serializeMigrationValue({ z: new Date('2026-01-02T03:04:05.000Z'), a: [1, 2] })).toEqual(
      {
        a: [1, 2],
        z: { $assistantMigration: ['date', '2026-01-02T03:04:05.000Z'] },
      },
    );
    expect(checksum({ b: 1, a: 2 })).toBe(checksum({ a: 2, b: 1 }));
  });

  it('keeps v1/v2 checksums legacy while v3 Unicode ordering is locale-independent', () => {
    expect(checksum({ a: 1, b: { c: 'legacy' } })).toBe(
      '07c644bf9c61f72f5a668e2562e720f6d38fd8702977141dbb26bf7446644c2f',
    );
    const value = { z: 1, ä: 2, a: { é: 3, e: 4 } };
    const legacy = checksum(value);
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (
      this: string,
      other,
    ) {
      return String(this) < other ? 1 : -1;
    });
    expect(checksumForMigrationVersion(value, 2)).not.toBe(legacy);
    expect(() => serializeMigrationValueV3(value)).not.toThrow();
    expect(checksumForMigrationVersion(value, 3)).toBe(checksumV3(value));
    localeCompare.mockRestore();
    expect(serializeMigrationValueV3(value)).toEqual({
      a: { e: 4, é: 3 },
      z: 1,
      ä: 2,
    });
  });

  it('preserves PostgreSQL microseconds while accepting legacy millisecond dates', () => {
    const first = serializeMigrationTimestamp('2026-09-19 12:34:56.123456+00');
    const second = serializeMigrationTimestamp('2026-09-19 12:34:56.123789+00');
    expect(first).toEqual({
      $assistantMigration: ['timestamp', '2026-09-19T12:34:56.123456Z'],
    });
    expect(checksum(first)).not.toBe(checksum(second));
    const precise = deserializeMigrationValue(first) as {
      seconds: bigint;
      nanoseconds: number;
    };
    expect(precise.seconds).toBe(1_789_821_296n);
    expect(precise.nanoseconds).toBe(123_456_000);
    expect(
      deserializeMigrationValue({
        $assistantMigration: ['date', '2026-09-19T12:34:56.123Z'],
      }),
    ).toEqual(new Date('2026-09-19T12:34:56.123Z'));
  });

  it('rejects unsupported tables before any database work', () => {
    expect(() => assertSupportedMigrationTables(['agents', 'not_a_real_table'])).toThrow(
      'Unsupported migration tables: not_a_real_table',
    );
  });

  it('enumerates the complete PostgreSQL schema without duplicate tables', async () => {
    const { MIGRATION_TABLES } = await import('./migration.js');
    expect(MIGRATION_TABLES).toHaveLength(66);
    expect(new Set(MIGRATION_TABLES.map(({ table }) => table))).toHaveProperty('size', 66);
  });

  it('rejects records outside the selected workspace and missing references', () => {
    expect(() =>
      validateMigrationReferences(
        [
          agent('agent-1'),
          {
            table: 'goals',
            collection: 'goals',
            id: 'goal-1',
            data: { id: 'goal-1', agentId: 'agent-2' },
            checksum: '',
          },
        ],
        'agent-1',
      ),
    ).toThrow('outside source workspace');
  });
});

describe('migration format integrity', () => {
  it('round trips reserved tags, nested JSON, bytes, dates and numeric arrays without changing user data', () => {
    const input = {
      nested: { $assistantMigration: ['date', '2026-01-01T00:00:00.000Z'], extra: true },
      escape: { $assistantMigrationEscape: { $assistantMigration: ['bytes', 'YQ=='] } },
      numbers: [1, 2, 3],
      date: new Date('2026-01-01T00:00:00.000Z'),
      bytes: Buffer.from('example'),
      bigint: 9_007_199_254_740_993n,
    };
    expect(deserializeMigrationValue(serializeMigrationValue(input))).toEqual(input);
  });
  it.each([
    { $assistantMigration: ['date', 'not-a-date'] },
    { $assistantMigration: ['date', '2026-02-30T00:00:00.000Z'] },
    { $assistantMigration: ['bytes', 'invalid!'] },
    { $assistantMigration: ['vector', ['1']] },
    { $assistantMigration: ['unknown', 'x'] },
    { $assistantMigration: ['date', '2026-01-01T00:00:00.000Z'], extra: 1 },
    {
      $assistantMigration: [
        'object',
        [
          ['a', 1],
          ['a', 2],
        ],
      ],
    },
  ])('rejects a malformed typed payload %j', (input) => {
    expect(() => deserializeMigrationValue(input as SerializedValue)).toThrow('Malformed');
  });
  function bundle(): MigrationBundle {
    const record = agent('owner');
    return {
      manifest: {
        format: 'assistant-workspace-migration',
        formatVersion: 1,
        mode: 'export',
        source: { kind: 'postgresql', agentId: 'owner', scope: 'installation', snapshot: '1:1:' },
        target: {
          projectId: 'customer-project',
          databaseId: '(default)',
          installationId: 'assistant',
        },
        coverage: { complete: false, supportedTables: ['agents'], omittedTables: ['tasks'] },
        tables: {
          agents: { collection: 'agents', count: 1, checksum: checksum([record]) },
        } as MigrationBundle['manifest']['tables'],
        recordCount: 1,
        bundleChecksum: checksum([record]),
        unsupportedTables: [],
      },
      records: [record],
    };
  }
  function validate(input: MigrationBundle) {
    validateMigrationBundle(input, { sourceAgentId: 'owner', target: input.manifest.target });
  }
  it('rejects unsupported source and fabricated coverage metadata', () => {
    const input = bundle();
    input.manifest.coverage.supportedTables = [];
    expect(() => validate(input)).toThrow('coverage metadata');
    input.manifest.coverage.supportedTables = ['agents'];
    input.manifest.source.snapshot = '';
    expect(() => validate(input)).toThrow('source metadata');
  });
  it('checks count and table summaries independently of valid record checksums', () => {
    const input = bundle();
    validate(input);
    input.manifest.recordCount++;
    expect(() => validate(input)).toThrow('record count');
    input.manifest.recordCount--;
    input.manifest.tables.agents.checksum = 'incorrect';
    expect(() => validate(input)).toThrow('summary mismatch');
  });
  it('validates v3 bundles with deterministic Unicode checksums', () => {
    const input = bundle();
    input.manifest.formatVersion = 3;
    const record = input.records[0];
    if (!record) throw new Error('Missing fixture record');
    record.data.äther = 'unicode';
    record.checksum = checksumV3(record.data);
    input.manifest.tables.agents = {
      collection: 'agents',
      count: 1,
      checksum: checksumV3([record]),
    };
    input.manifest.bundleChecksum = checksumV3([record]);
    expect(() => validate(input)).not.toThrow();
  });
  it('rejects duplicate records even with newly recomputed bundle and table checksums', () => {
    const input = bundle();
    const first = input.records[0];
    if (!first) throw new Error('Missing fixture record');
    input.records.push(first);
    input.manifest.recordCount = 2;
    input.manifest.bundleChecksum = checksum(input.records);
    input.manifest.tables.agents = {
      collection: 'agents',
      count: 2,
      checksum: checksum(input.records),
    };
    expect(() => validate(input)).toThrow('Duplicate');
  });
});

describe('migration required ownership', () => {
  it('rejects a task with an absent owner instead of importing an unclaimable row', () => {
    const task: MigrationRecord = {
      table: 'tasks',
      collection: 'tasks',
      id: 'task',
      data: { id: 'task' },
      checksum: '',
    };
    expect(() => validateMigrationReferences([agent('owner'), task], 'owner')).toThrow(
      'reference agentId',
    );
  });
  it('rejects approval links to another task even when both IDs exist', () => {
    const row = (
      table: MigrationRecord['table'],
      collection: MigrationRecord['collection'],
      id: string,
      data: MigrationRecord['data'],
    ): MigrationRecord => ({ table, collection, id, data: { id, ...data }, checksum: '' });
    const rows = [
      agent('owner'),
      row('tasks', 'tasks', 'one', { agentId: 'owner' }),
      row('tasks', 'tasks', 'two', { agentId: 'owner' }),
      row('tool_calls', 'toolCalls', 'call', { taskId: 'one', approvalId: 'approval' }),
      row('approvals', 'approvals', 'approval', { taskId: 'two', toolCallId: 'call' }),
    ];
    expect(() => validateMigrationReferences(rows, 'owner')).toThrow(
      'Inconsistent approval tool linkage',
    );
  });
});
