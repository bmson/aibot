import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createInstallationStore } from '@assistant/firestore';
import { importWorkspaceBundle } from '@assistant/firestore/workspace-migration';
import { type MigrationBundle, validateMigrationBundle } from '@assistant/persistence';

const { values } = parseArgs({
  options: {
    help: { type: 'boolean' },
    write: { type: 'boolean' },
    verify: { type: 'boolean' },
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
    'Preview, import, or verify a bundle. --write and --verify require --in plus explicit source/target identities.',
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
if (!values.write && !values.verify) {
  const result = await importWorkspaceBundle(
    {} as Parameters<typeof importWorkspaceBundle>[0],
    bundle,
    { sourceAgentId, target },
  );
  console.log(
    JSON.stringify(
      {
        ...result,
        sourceAgentId,
        target,
        checksum: bundle.manifest.bundleChecksum,
        coverage: bundle.manifest.coverage,
        embeddingSpace: bundle.manifest.source.embeddingSpace ?? null,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (values.write && values.verify) throw new Error('Choose either --write or --verify');
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
    mode: values.verify ? 'verify' : 'write',
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await store.db.terminate();
}
