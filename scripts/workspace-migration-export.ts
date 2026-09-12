import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { exportWorkspaceSnapshot } from '@assistant/db/workspace-migration';
import { MIGRATION_TABLES } from '@assistant/persistence';

const { values } = parseArgs({
  options: {
    help: { type: 'boolean' },
    export: { type: 'boolean' },
    tables: { type: 'string' },
    'database-url': { type: 'string' },
    'agent-id': { type: 'string' },
    out: { type: 'string' },
    'project-id': { type: 'string' },
    'database-id': { type: 'string' },
    'installation-id': { type: 'string' },
  },
  strict: true,
});
if (values.help) {
  console.log(
    'Preview or export PostgreSQL workspace data. Export requires --export --database-url --agent-id --project-id --installation-id.',
  );
  process.exit(0);
}

const tables =
  values.tables?.split(',').filter(Boolean) ?? MIGRATION_TABLES.map(({ table }) => table);
const target = {
  projectId: values['project-id'] ?? '<project-id>',
  databaseId: values['database-id'] ?? '(default)',
  installationId: values['installation-id'] ?? '<installation-id>',
};
if (!values.export) {
  console.log(
    JSON.stringify(
      { mode: 'preview', source: 'postgresql', target, tables, writes: 'none' },
      null,
      2,
    ),
  );
  process.exit(0);
}
const databaseUrl = values['database-url'];
const agentId = values['agent-id'];
const output = values.out ?? 'workspace-migration.json';
if (
  !databaseUrl ||
  !agentId ||
  target.projectId.startsWith('<') ||
  target.installationId.startsWith('<')
)
  throw new Error(
    '--export requires --database-url, --agent-id, --project-id, and --installation-id',
  );
const bundle = await exportWorkspaceSnapshot({ databaseUrl, agentId, target, tables });
await writeFile(output, `${JSON.stringify(bundle, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(
  JSON.stringify(
    {
      mode: 'export',
      output,
      records: bundle.records.length,
      checksum: bundle.manifest.bundleChecksum,
    },
    null,
    2,
  ),
);
