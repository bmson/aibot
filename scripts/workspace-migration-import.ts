import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createInstallationStore } from '@assistant/firestore';
import { importWorkspaceBundle } from '@assistant/firestore/workspace-migration';
import { type MigrationBundle, validateMigrationBundle } from '@assistant/persistence';

const { values } = parseArgs({
  options: {
    help: { type: 'boolean' },
    write: { type: 'boolean' },
    'allow-cloud': { type: 'boolean' },
    in: { type: 'string' },
    'agent-id': { type: 'string' },
    'project-id': { type: 'string' },
    'database-id': { type: 'string' },
    'installation-id': { type: 'string' },
  },
  strict: true,
});
if (values.help) {
  console.log(
    'Preview or import a bundle. Write requires --write --in --agent-id --project-id --database-id --installation-id.',
  );
  process.exit(0);
}

const input = values.in;
if (!input) throw new Error('--in is required');
const bundle = JSON.parse(await readFile(input, 'utf8')) as MigrationBundle;
const target = {
  projectId: values['project-id'] ?? bundle.manifest.target.projectId,
  databaseId: values['database-id'] ?? bundle.manifest.target.databaseId,
  installationId: values['installation-id'] ?? bundle.manifest.target.installationId,
};
const sourceAgentId = values['agent-id'] ?? bundle.manifest.source.agentId;
validateMigrationBundle(bundle, { sourceAgentId, target });
if (!values.write) {
  console.log(
    JSON.stringify(
      {
        mode: 'preview',
        sourceAgentId,
        target,
        records: bundle.records.length,
        checksum: bundle.manifest.bundleChecksum,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (
  !values['agent-id'] ||
  !values['project-id'] ||
  !values['database-id'] ||
  !values['installation-id']
)
  throw new Error(
    'Writes require explicit --agent-id, --project-id, --database-id, and --installation-id',
  );
if (!process.env.FIRESTORE_EMULATOR_HOST && !values['allow-cloud'])
  throw new Error(
    'Refusing Firestore writes without FIRESTORE_EMULATOR_HOST or explicit --allow-cloud',
  );
const store = createInstallationStore(target);
try {
  const result = await importWorkspaceBundle(store, bundle, {
    sourceAgentId,
    target,
    mode: 'write',
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await store.db.terminate();
}
