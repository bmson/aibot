import { pathToFileURL } from 'node:url';
import { loadConfig } from '@assistant/config';
import postgres from 'postgres';

export interface SchemaDiagnosis {
  connection: {
    database: string;
    currentSchema: string | null;
    searchPath: string;
    schemas: string[];
  };
  agents: Array<{ schema: string; name: string; kind: string }>;
  journal: {
    schema: 'drizzle';
    table: '__drizzle_migrations';
    exists: boolean;
    count: number;
    minCreatedAt: number | null;
    maxCreatedAt: number | null;
  };
  tableCountsBySchema: Array<{ schema: string; count: number }>;
}

function finiteTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * Inspect only database metadata in a read-only transaction.
 *
 * The URL is accepted as an argument so callers can supply the same secret
 * used by the migration job without ever including it in the report.
 */
export async function diagnoseSchema(databaseUrl: string): Promise<SchemaDiagnosis> {
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 30,
    connection: { statement_timeout: 30_000 },
    onnotice: () => {},
  });
  try {
    return await sql.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY`;

      const [connection] = await tx<
        {
          database: string;
          currentSchema: string | null;
          searchPath: string;
          schemas: string[];
        }[]
      >`
        SELECT
          current_database() AS database,
          current_schema() AS "currentSchema",
          current_setting('search_path') AS "searchPath",
          current_schemas(false) AS schemas
      `;
      if (!connection) throw new Error('connection metadata was unavailable');

      const agents = await tx<{ schema: string; name: string; kind: string }[]>`
        SELECT
          n.nspname AS schema,
          c.relname AS name,
          c.relkind AS kind
        FROM pg_catalog.pg_class AS c
        JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
        WHERE c.relname = 'agents'
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND n.nspname <> 'information_schema'
          AND n.nspname NOT LIKE 'pg_%'
        ORDER BY n.nspname, c.relkind
      `;

      const [journalRelation] = await tx<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_class AS c
          JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
          WHERE n.nspname = 'drizzle'
            AND c.relname = '__drizzle_migrations'
            AND c.relkind IN ('r', 'p')
        ) AS exists
      `;
      const journalExists = journalRelation?.exists === true;

      let journal = {
        schema: 'drizzle' as const,
        table: '__drizzle_migrations' as const,
        exists: journalExists,
        count: 0,
        minCreatedAt: null as number | null,
        maxCreatedAt: null as number | null,
      };
      if (journalExists) {
        const [journalStats] = await tx<
          {
            count: number;
            minCreatedAt: unknown;
            maxCreatedAt: unknown;
          }[]
        >`
          SELECT
            count(*)::int AS count,
            min(created_at) AS "minCreatedAt",
            max(created_at) AS "maxCreatedAt"
          FROM drizzle.__drizzle_migrations
        `;
        journal = {
          ...journal,
          count: journalStats?.count ?? 0,
          minCreatedAt: finiteTimestamp(journalStats?.minCreatedAt),
          maxCreatedAt: finiteTimestamp(journalStats?.maxCreatedAt),
        };
      }

      const tableCountsBySchema = await tx<{ schema: string; count: number }[]>`
        SELECT
          n.nspname AS schema,
          count(*)::int AS count
        FROM pg_catalog.pg_class AS c
        JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p')
          AND n.nspname <> 'information_schema'
          AND n.nspname NOT LIKE 'pg_%'
        GROUP BY n.nspname
        ORDER BY n.nspname
      `;

      return {
        connection,
        agents,
        journal,
        tableCountsBySchema,
      };
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z0-9]+$/.test(code) ? code : null;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stdout.write('Usage: pnpm --filter @assistant/db diagnose-schema\n');
    return;
  }

  try {
    const { DATABASE_URL } = loadConfig();
    const report = await diagnoseSchema(DATABASE_URL);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    // Never echo driver errors: connection errors can contain connection URLs.
    process.stderr.write(
      `${JSON.stringify({ error: 'schema diagnosis failed', code: errorCode(error) })}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
