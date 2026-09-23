import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createInstallationStore } from '@assistant/firestore';
import {
  activateWorkspaceBundle,
  importWorkspaceBundle,
} from '@assistant/firestore/workspace-migration';
import { type MigrationBundle, validateMigrationBundle } from '@assistant/persistence';
import { createGcloudAuthClient } from './gcloud-auth.js';

const { values } = parseArgs({
  options: {
    help: { type: 'boolean' },
    write: { type: 'boolean' },
    verify: { type: 'boolean' },
    activate: { type: 'boolean' },
    'allow-cloud': { type: 'boolean' },
    'gcloud-auth': { type: 'boolean' },
    in: { type: 'string' },
    'agent-id': { type: 'string' },
    'project-id': { type: 'string' },
    'database-id': { type: 'string' },
    'installation-id': { type: 'string' },
    'source-write-fence-id': { type: 'string' },
    'source-writes-drained-at': { type: 'string' },
    'snapshot-uri': { type: 'string' },
    'snapshot-generation': { type: 'string' },
    'snapshot-sha256': { type: 'string' },
  },
  strict: true,
});
if (values.help) {
  console.log(
    'Preview, import, verify, or explicitly activate a bundle. Cloud writes use ADC by default; --gcloud-auth uses the active gcloud identity.',
  );
  process.exit(0);
}

const input = values.in;
if (!input) throw new Error('--in is required');
const snapshotBytes = await readFile(input);
const bundle = JSON.parse(snapshotBytes.toString('utf8')) as MigrationBundle;
const target = {
  projectId: values['project-id'] ?? bundle.manifest.target.projectId,
  databaseId: values['database-id'] ?? bundle.manifest.target.databaseId,
  installationId: values['installation-id'] ?? bundle.manifest.target.installationId,
};
const sourceAgentId = values['agent-id'] ?? bundle.manifest.source.agentId;
validateMigrationBundle(bundle, { sourceAgentId, target });
if (!values.write && !values.verify && !values.activate) {
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
if ([values.write, values.verify, values.activate].filter(Boolean).length > 1)
  throw new Error('Choose only one of --write, --verify, or --activate');
if (
  !values['agent-id'] ||
  !values['project-id'] ||
  !values['database-id'] ||
  !values['installation-id']
)
  throw new Error(
    'Writes and activation require explicit --agent-id, --project-id, --database-id, and --installation-id',
  );
if (
  values.activate &&
  (!values['source-write-fence-id'] ||
    !values['source-writes-drained-at'] ||
    !values['snapshot-uri'] ||
    !values['snapshot-generation'] ||
    !values['snapshot-sha256'])
)
  throw new Error(
    'Activation requires --source-write-fence-id, --source-writes-drained-at, --snapshot-uri, --snapshot-generation, and --snapshot-sha256',
  );
if (!process.env.FIRESTORE_EMULATOR_HOST && !values['allow-cloud'])
  throw new Error(
    'Refusing Firestore writes without FIRESTORE_EMULATOR_HOST or explicit --allow-cloud',
  );
const authClient = values['gcloud-auth'] ? await createGcloudAuthClient() : undefined;
const store = createInstallationStore({ ...target, ...(authClient ? { authClient } : {}) });
try {
  let activationSnapshotBytes = snapshotBytes;
  if (values.activate && !process.env.FIRESTORE_EMULATOR_HOST) {
    const uri = values['snapshot-uri'] ?? '';
    const generation = values['snapshot-generation'] ?? '';
    if (
      !uri.startsWith(
        `gs://${target.projectId}-workspace/workspace/${target.installationId}/migration/snapshots/`,
      ) ||
      !uri.endsWith('.json') ||
      !/^[1-9]\d*$/.test(generation)
    )
      throw new Error('Pinned snapshot must identify this installation and a positive generation');
    try {
      activationSnapshotBytes = execFileSync(
        'gcloud',
        ['storage', 'cat', `${uri}#${generation}`, `--project=${target.projectId}`],
        { encoding: 'buffer', maxBuffer: 550_000_000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch {
      throw new Error('Could not read the specified pinned snapshot generation from Cloud Storage');
    }
    if (!activationSnapshotBytes.equals(snapshotBytes))
      throw new Error(
        'Local bundle bytes do not match the specified pinned Cloud Storage generation',
      );
  }
  const result = values.activate
    ? await activateWorkspaceBundle(store, bundle, {
        sourceAgentId,
        target,
        snapshotBytes: activationSnapshotBytes,
        evidence: {
          sourceWriteFenceId: values['source-write-fence-id'] ?? '',
          sourceWritesDrainedAt: values['source-writes-drained-at'] ?? '',
          snapshotUri: values['snapshot-uri'] ?? '',
          snapshotGeneration: values['snapshot-generation'] ?? '',
          snapshotSha256: values['snapshot-sha256'] ?? '',
        },
      })
    : await importWorkspaceBundle(store, bundle, {
        sourceAgentId,
        target,
        mode: values.verify ? 'verify' : 'write',
      });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await store.db.terminate();
}
