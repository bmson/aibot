import {
  assertSupportedMigrationTables,
  checksum,
  MIGRATION_TABLES,
  type MigrationBundle,
  type MigrationManifest,
  type MigrationRecord,
  type MigrationTable,
  type MigrationTarget,
  serializeMigrationValue,
  serializeMigrationVector,
  snakeToCamel,
  validateMigrationReferences,
} from '@assistant/persistence';
import postgres from 'postgres';

export type WorkspaceSnapshotOptions = {
  databaseUrl: string;
  agentId: string;
  target: MigrationTarget;
  tables?: readonly string[];
};

function identifiers(table: MigrationTable) {
  const definition = MIGRATION_TABLES.find((candidate) => candidate.table === table);
  if (!definition) throw new Error(`Unsupported migration table: ${table}`);
  return definition;
}

/**
 * Export a workspace using one PostgreSQL REPEATABLE READ, READ ONLY snapshot.
 * The query shapes are intentionally explicit: a future table must be added
 * with its ownership/reference rule instead of accidentally exporting data.
 */
export async function exportWorkspaceSnapshot(
  options: WorkspaceSnapshotOptions,
): Promise<MigrationBundle> {
  const tables = assertSupportedMigrationTables(
    options.tables ?? MIGRATION_TABLES.map(({ table }) => table),
  );
  const client = postgres(options.databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    onnotice: () => {},
  });
  try {
    return await client.begin(async (connection) => {
      await connection`set transaction isolation level repeatable read, read only`;
      const [snapshotRow] = await connection<
        { snapshot: string }[]
      >`select txid_current_snapshot() as snapshot`;
      if (!snapshotRow?.snapshot)
        throw new Error('PostgreSQL did not return a snapshot identifier');
      const snapshot = snapshotRow.snapshot;
      const [agentCountRow] = await connection<
        { count: string }[]
      >`select count(*)::text as count from agents`;
      const agentCount = agentCountRow?.count;
      if (
        Number(agentCount) !== 1 &&
        tables.some((table) => table === 'contacts' || table === 'memory_tombstones')
      )
        throw new Error('Installation-wide tables require exactly one PostgreSQL agent');
      const sourceTables = await connection<
        { table_name: string }[]
      >`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`;
      const records: MigrationRecord[] = [];
      for (const table of tables) {
        const definition = identifiers(table);
        let rows: Record<string, unknown>[];
        if (table === 'agents') {
          rows = await connection`select * from "agents" where id = ${options.agentId} order by id`;
        } else if (table === 'channel_bindings') {
          rows =
            await connection`select cb.* from "channel_bindings" cb join conversations c on c.id = cb.conversation_id where c.agent_id = ${options.agentId} order by cb.id`;
        } else if (table === 'messages') {
          rows =
            await connection`select m.* from "messages" m join conversations c on c.id = m.conversation_id where c.agent_id = ${options.agentId} order by m.id`;
        } else if (table === 'tool_calls' || table === 'approvals') {
          const source = table === 'tool_calls' ? 'tool_calls' : 'approvals';
          rows = await connection.unsafe(
            `select x.* from "${source}" x join tasks t on t.id = x.task_id where t.agent_id = $1 order by x.id`,
            [options.agentId],
          );
        } else if (table === 'contacts' || table === 'memory_tombstones') {
          // These legacy tables are installation-wide (they have no agent_id).
          rows = await connection.unsafe(`select * from "${table}" order by 1`);
        } else {
          rows = await connection.unsafe(
            `select * from "${table}" where agent_id = $1 order by "${definition.id}"`,
            [options.agentId],
          );
        }
        for (const row of rows) {
          const rawId = row[definition.id];
          if (rawId === undefined || rawId === null)
            throw new Error(`Missing ${table}.${definition.id}`);
          const data = Object.fromEntries(
            Object.entries(row)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, value]) => {
                if (
                  key === 'embedding' &&
                  Array.isArray(value) &&
                  value.every((item) => typeof item === 'number')
                )
                  return [snakeToCamel(key), serializeMigrationVector(value)];
                if (key === 'embedding' && typeof value === 'string') {
                  try {
                    const vector = JSON.parse(value) as unknown;
                    if (Array.isArray(vector) && vector.every((item) => typeof item === 'number'))
                      return [snakeToCamel(key), serializeMigrationVector(vector)];
                  } catch {
                    // Keep malformed vectors visible to validation rather than silently changing them.
                  }
                }
                return [snakeToCamel(key), serializeMigrationValue(value)];
              }),
          );
          records.push({
            table,
            collection: definition.collection,
            id: String(rawId),
            data,
            checksum: checksum(data),
          });
        }
      }
      records.sort((a, b) => `${a.table}:${a.id}`.localeCompare(`${b.table}:${b.id}`));
      validateMigrationReferences(records, options.agentId);
      const tableSummary = Object.fromEntries(
        tables.map((table) => {
          const definition = identifiers(table);
          const selected = records.filter((record) => record.table === table);
          return [
            table,
            {
              collection: definition.collection,
              count: selected.length,
              checksum: checksum(selected),
            },
          ];
        }),
      ) as MigrationManifest['tables'];
      const manifest: MigrationManifest = {
        format: 'assistant-workspace-migration',
        formatVersion: 1,
        mode: 'export',
        source: { kind: 'postgresql', agentId: options.agentId, scope: 'installation', snapshot },
        target: options.target,
        tables: tableSummary,
        coverage: {
          complete: false,
          supportedTables: tables,
          omittedTables: sourceTables
            .map((row) => row.table_name)
            .filter((table) => !tables.includes(table as MigrationTable)),
        },
        recordCount: records.length,
        bundleChecksum: checksum(records),
        unsupportedTables: [],
      };
      return { manifest, records };
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}
