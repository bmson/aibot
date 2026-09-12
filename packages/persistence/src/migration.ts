import { createHash } from 'node:crypto';

/**
 * The migration format is intentionally smaller than the PostgreSQL schema.
 * Adding a table here is an explicit compatibility decision: the exporter and
 * importer must both understand its references and Firestore representation.
 */
export const MIGRATION_TABLES = [
  { table: 'agents', collection: 'agents', id: 'id', scope: 'agent' },
  { table: 'contacts', collection: 'contacts', id: 'id', scope: 'agent' },
  { table: 'conversations', collection: 'conversations', id: 'id', scope: 'agent' },
  { table: 'channel_bindings', collection: 'channelBindings', id: 'id', scope: 'conversation' },
  { table: 'messages', collection: 'messages', id: 'id', scope: 'conversation' },
  { table: 'tasks', collection: 'tasks', id: 'id', scope: 'agent' },
  { table: 'tool_calls', collection: 'toolCalls', id: 'id', scope: 'agent' },
  { table: 'approvals', collection: 'approvals', id: 'id', scope: 'agent' },
  { table: 'approval_policies', collection: 'approvalPolicies', id: 'id', scope: 'agent' },
  { table: 'schedules', collection: 'schedules', id: 'id', scope: 'agent' },
  { table: 'memories', collection: 'memories', id: 'id', scope: 'agent' },
  {
    table: 'memory_tombstones',
    collection: 'memoryTombstones',
    id: 'content_hash',
    scope: 'agent',
  },
  { table: 'goals', collection: 'goals', id: 'id', scope: 'agent' },
] as const;

export type MigrationTable = (typeof MIGRATION_TABLES)[number]['table'];
export type MigrationCollection = (typeof MIGRATION_TABLES)[number]['collection'];
export type MigrationScope = (typeof MIGRATION_TABLES)[number]['scope'];

export type MigrationTarget = {
  projectId: string;
  databaseId: string;
  installationId: string;
};

export type SerializedValue =
  | null
  | boolean
  | string
  | number
  | SerializedValue[]
  | { [key: string]: SerializedValue }
  | { $assistantMigration: ['date' | 'bytes' | 'vector', string | number[]] };

export type MigrationRecord = {
  table: MigrationTable;
  collection: MigrationCollection;
  id: string;
  data: Record<string, SerializedValue>;
  checksum: string;
};

export type MigrationManifest = {
  format: 'assistant-workspace-migration';
  formatVersion: 1;
  mode: 'preview' | 'export';
  source: { kind: 'postgresql'; agentId: string; scope: 'installation'; snapshot: string };
  target: MigrationTarget;
  tables: Record<
    MigrationTable,
    { collection: MigrationCollection; count: number; checksum: string }
  >;
  coverage: { complete: false; supportedTables: MigrationTable[]; omittedTables: string[] };
  recordCount: number;
  bundleChecksum: string;
  unsupportedTables: string[];
};

export type MigrationBundle = {
  manifest: MigrationManifest;
  records: MigrationRecord[];
};

export function tableDefinition(table: string) {
  return MIGRATION_TABLES.find((definition) => definition.table === table);
}

export function assertSupportedMigrationTables(tables: readonly string[]): MigrationTable[] {
  const unique = [...new Set(tables)];
  const unsupported = unique.filter((table) => !tableDefinition(table));
  if (unsupported.length)
    throw new Error(`Unsupported migration tables: ${unsupported.sort().join(', ')}`);
  return unique as MigrationTable[];
}

/** Stable JSON encoding. Only a reserved-key collision needs an object envelope. */
export function serializeMigrationValue(value: unknown): SerializedValue {
  function visit(input: unknown, depth: number): SerializedValue {
    if (depth > 64) throw new Error('Migration value exceeds the nesting limit');
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Error('Cannot migrate a non-finite number');
      return input;
    }
    if (input instanceof Date) {
      if (!Number.isFinite(input.getTime())) throw new Error('Cannot migrate an invalid date');
      return { $assistantMigration: ['date', input.toISOString()] };
    }
    if (input instanceof Uint8Array)
      return { $assistantMigration: ['bytes', Buffer.from(input).toString('base64')] };
    if (Array.isArray(input)) return input.map((item) => visit(item, depth + 1));
    if (input && typeof input === 'object') {
      const entries = Object.entries(input)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, visit(item, depth + 1)] as [string, SerializedValue]);
      if (Object.hasOwn(input, '$assistantMigration'))
        return { $assistantMigration: ['object', entries] };
      return Object.fromEntries(entries);
    }
    throw new Error(`Cannot migrate value of type ${typeof input}`);
  }
  return visit(value, 0);
}

export function serializeMigrationVector(value: readonly number[]): SerializedValue {
  if (!value.every((item) => typeof item === 'number' && Number.isFinite(item)))
    throw new Error('Cannot migrate a non-finite vector');
  return { $assistantMigration: ['vector', [...value]] };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(serializeMigrationValue(value));
}

export function checksum(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function snakeToCamel(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

export function deserializeMigrationValue(value: SerializedValue): unknown {
  function visit(input: unknown, depth: number): unknown {
    if (depth > 64) throw new Error('Migration value exceeds the nesting limit');
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map((item) => visit(item, depth + 1));
    if (!input || typeof input !== 'object') throw new Error('Invalid migration value');
    if (Object.hasOwn(input, '$assistantMigration')) {
      const tag = (input as Record<string, unknown>).$assistantMigration;
      if (Object.keys(input).length !== 1 || !Array.isArray(tag) || tag.length !== 2)
        throw new Error('Malformed migration tag');
      const [type, payload] = tag;
      if (type === 'date' && typeof payload === 'string') {
        const date = new Date(payload);
        if (Number.isFinite(date.getTime()) && date.toISOString() === payload) return date;
      }
      if (type === 'bytes' && typeof payload === 'string') {
        const bytes = Buffer.from(payload, 'base64');
        if (bytes.toString('base64') === payload) return bytes;
      }
      if (
        type === 'vector' &&
        Array.isArray(payload) &&
        payload.every((item) => typeof item === 'number' && Number.isFinite(item))
      )
        return [...payload];
      if (type === 'object' && Array.isArray(payload)) {
        const seen = new Set<string>();
        const entries = payload.map((entry) => {
          if (
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            typeof entry[0] !== 'string' ||
            seen.has(entry[0])
          )
            throw new Error('Malformed migration object tag');
          seen.add(entry[0]);
          return [entry[0], visit(entry[1], depth + 1)];
        });
        // Deliberately do not visit the reconstructed object again: its reserved key is user data.
        return Object.fromEntries(entries);
      }
      throw new Error('Malformed migration tag');
    }
    return Object.fromEntries(
      Object.entries(input).map(([key, item]) => [key, visit(item, depth + 1)]),
    );
  }
  return visit(value, 0);
}

export function validateMigrationBundle(
  bundle: MigrationBundle,
  expected: { sourceAgentId: string; target: MigrationTarget },
): void {
  if (
    bundle.manifest.format !== 'assistant-workspace-migration' ||
    bundle.manifest.formatVersion !== 1
  )
    throw new Error('Unsupported migration bundle format');
  const manifest = bundle.manifest;
  if (
    manifest.source.kind !== 'postgresql' ||
    manifest.source.scope !== 'installation' ||
    typeof manifest.source.snapshot !== 'string' ||
    !manifest.source.snapshot.trim() ||
    manifest.mode !== 'export'
  )
    throw new Error('Invalid migration source metadata');
  const selectedTables = Object.keys(manifest.tables).sort();
  if (
    manifest.coverage?.complete !== false ||
    !Array.isArray(manifest.coverage.supportedTables) ||
    canonicalJson([...manifest.coverage.supportedTables].sort()) !==
      canonicalJson(selectedTables) ||
    !Array.isArray(manifest.coverage.omittedTables) ||
    manifest.coverage.omittedTables.some(
      (table) => typeof table !== 'string' || selectedTables.includes(table),
    ) ||
    !Array.isArray(manifest.unsupportedTables) ||
    manifest.unsupportedTables.length !== 0
  )
    throw new Error('Invalid migration coverage metadata');
  if (bundle.manifest.source.agentId !== expected.sourceAgentId)
    throw new Error('Migration source agent does not match the requested workspace');
  if (canonicalJson(bundle.manifest.target) !== canonicalJson(expected.target))
    throw new Error('Migration target identity does not match the requested installation');
  const sorted = [...bundle.records].sort((a, b) =>
    `${a.table}:${a.id}`.localeCompare(`${b.table}:${b.id}`),
  );
  if (bundle.manifest.recordCount !== sorted.length)
    throw new Error('Migration record count mismatch');
  const seen = new Set<string>();
  if (checksum(sorted) !== bundle.manifest.bundleChecksum)
    throw new Error('Migration bundle checksum mismatch');
  for (const record of sorted) {
    const key = `${record.table}:${record.id}`;
    if (seen.has(key)) throw new Error(`Duplicate migration record: ${key}`);
    seen.add(key);
    if (record.checksum !== checksum(record.data))
      throw new Error(`Record checksum mismatch: ${record.table}/${record.id}`);
    if (tableDefinition(record.table)?.collection !== record.collection)
      throw new Error(`Invalid collection mapping for ${record.table}`);
    const definition = tableDefinition(record.table);
    const primary = definition?.id === 'content_hash' ? record.data.contentHash : record.data.id;
    if (String(primary ?? '') !== record.id) throw new Error(`Primary ID mismatch: ${key}`);
    const summary = bundle.manifest.tables[record.table];
    for (const value of Object.values(record.data)) deserializeMigrationValue(value);
    if (!summary || summary.collection !== record.collection)
      throw new Error(`Missing table summary: ${record.table}`);
  }
  for (const [table, summary] of Object.entries(bundle.manifest.tables)) {
    if (tableDefinition(table)?.collection !== summary.collection)
      throw new Error(`Unsupported migration table summary: ${table}`);
    const selected = sorted.filter((record) => record.table === table);
    if (summary.count !== selected.length || summary.checksum !== checksum(selected))
      throw new Error(`Table summary mismatch: ${table}`);
  }
  const owner = sorted.find(
    (record) => record.table === 'agents' && record.id === expected.sourceAgentId,
  );
  if (
    !owner ||
    typeof owner.data.name !== 'string' ||
    typeof owner.data.email !== 'string' ||
    typeof owner.data.workspacePrefix !== 'string'
  )
    throw new Error('Source agent is missing required identity fields');
  validateMigrationReferences(sorted, expected.sourceAgentId);
}

/** Validate ownership and required foreign keys before a bundle can be imported. */
export function validateMigrationReferences(
  records: readonly MigrationRecord[],
  sourceAgentId: string,
): void {
  const ids = new Map<string, Set<string>>();
  for (const record of records) {
    const values = ids.get(record.table) ?? new Set<string>();
    values.add(record.id);
    ids.set(record.table, values);
  }
  if (!ids.get('agents')?.has(sourceAgentId))
    throw new Error('Migration bundle must include the source agent record');
  if ((ids.get('agents')?.size ?? 0) !== 1)
    throw new Error(
      'Migration bundle must contain exactly one agent for installation-wide records',
    );
  const requireReference = (
    record: MigrationRecord,
    field: string,
    table: MigrationTable,
    required = false,
  ) => {
    const value = record.data[field];
    if (value == null && !required) return;
    if (typeof value !== 'string' || !ids.get(table)?.has(value))
      throw new Error(`Invalid ${record.table}/${record.id} reference ${field}=${String(value)}`);
  };
  for (const record of records) {
    if (
      record.table !== 'agents' &&
      'agentId' in record.data &&
      record.data.agentId !== sourceAgentId
    )
      throw new Error(`Record outside source workspace: ${record.table}/${record.id}`);
    if (
      ['conversations', 'tasks', 'approval_policies', 'schedules', 'memories', 'goals'].includes(
        record.table,
      )
    )
      requireReference(record, 'agentId', 'agents', true);
    if (record.table === 'channel_bindings')
      requireReference(record, 'conversationId', 'conversations', true);
    if (record.table === 'messages') {
      requireReference(record, 'conversationId', 'conversations', true);
      requireReference(record, 'taskId', 'tasks');
    }
    if (record.table === 'tasks') {
      requireReference(record, 'conversationId', 'conversations');
      requireReference(record, 'parentTaskId', 'tasks');
      requireReference(record, 'scheduleId', 'schedules');
    }
    if (record.table === 'tool_calls') {
      requireReference(record, 'taskId', 'tasks', true);
      requireReference(record, 'approvalId', 'approvals');
    }
    if (record.table === 'approvals') {
      requireReference(record, 'taskId', 'tasks', true);
      requireReference(record, 'toolCallId', 'tool_calls', true);
      const call = records.find(
        (candidate) => candidate.table === 'tool_calls' && candidate.id === record.data.toolCallId,
      );
      if (call?.data.taskId !== record.data.taskId || call?.data.approvalId !== record.id)
        throw new Error(`Inconsistent approval tool linkage: ${record.id}`);
    }
    if (record.table === 'memories') {
      requireReference(record, 'subjectContactId', 'contacts');
      requireReference(record, 'sourceTaskId', 'tasks');
      requireReference(record, 'goalId', 'goals');
    }
  }
}
