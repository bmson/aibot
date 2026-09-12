import { describe, expect, it } from 'vitest';
import {
  assertSupportedMigrationTables,
  checksum,
  deserializeMigrationValue,
  type MigrationBundle,
  type MigrationRecord,
  type SerializedValue,
  serializeMigrationValue,
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

  it('rejects unsupported tables before any database work', () => {
    expect(() => assertSupportedMigrationTables(['agents', 'ambient_snapshots'])).toThrow(
      'Unsupported migration tables: ambient_snapshots',
    );
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
