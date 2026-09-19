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
    'embedding-provider': { type: 'string' },
    'embedding-model': { type: 'string' },
    'embedding-dimensions': { type: 'string' },
    'embedding-revision': { type: 'string' },
  },
  strict: true,
});
if (values.help) {
  console.log(
    'Preview or export all PostgreSQL installation data. Export requires source/target identities; vector rows also require explicit embedding provenance.',
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
const embeddingFields = [
  values['embedding-provider'],
  values['embedding-model'],
  values['embedding-dimensions'],
  values['embedding-revision'],
];
if (embeddingFields.some(Boolean) && !embeddingFields.every(Boolean))
  throw new Error('Embedding provenance requires provider, model, dimensions, and revision');
const embeddingDimensions = values['embedding-dimensions']
  ? Number(values['embedding-dimensions'])
  : undefined;
if (
  embeddingDimensions !== undefined &&
  (!Number.isSafeInteger(embeddingDimensions) || embeddingDimensions < 1)
)
  throw new Error('--embedding-dimensions must be a positive integer');
const embeddingSpace = embeddingFields.every(Boolean)
  ? {
      provider: values['embedding-provider'] as string,
      model: values['embedding-model'] as string,
      dimensions: embeddingDimensions as number,
      revision: values['embedding-revision'] as string,
    }
  : undefined;
if (
  !databaseUrl ||
  !agentId ||
  target.projectId.startsWith('<') ||
  target.installationId.startsWith('<')
)
  throw new Error(
    '--export requires --database-url, --agent-id, --project-id, and --installation-id',
  );
const bundle = await exportWorkspaceSnapshot({
  databaseUrl,
  agentId,
  target,
  tables,
  ...(embeddingSpace ? { embeddingSpace } : {}),
});
await writeFile(output, `${JSON.stringify(bundle, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(
  JSON.stringify(
    {
      mode: 'export',
      output,
      records: bundle.records.length,
      checksum: bundle.manifest.bundleChecksum,
      coverage: bundle.manifest.coverage,
      embeddingSpace: bundle.manifest.source.embeddingSpace ?? null,
    },
    null,
    2,
  ),
);
