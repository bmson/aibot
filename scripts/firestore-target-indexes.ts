import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  provisionTargetFirestoreIndexes,
  verifyConsumerIndexReadiness,
} from '../packages/setup/src/consumer-index-readiness.js';
import type { InstallationIdentity } from '../packages/setup/src/installation-manifest.js';
import { systemRunner } from '../packages/setup/src/runner.js';

function argument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv
    .slice(2)
    .find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length);
  if (!value) throw new Error(`Required argument: ${prefix}VALUE`);
  return value;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== 'apply' && mode !== 'verify')
    throw new Error(
      'Usage: pnpm firestore:indexes apply|verify --project=PROJECT --database=DATABASE',
    );
  const projectId = argument('project');
  const databaseId = argument('database');
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId))
    throw new Error('Invalid Google project ID');
  if (
    !/^[a-z][a-z0-9-]{2,61}[a-z0-9]$/.test(databaseId) ||
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(databaseId)
  )
    throw new Error('An existing named Firestore database ID is required');
  const identity: InstallationIdentity = {
    installationId: 'existing-database-index-maintenance',
    projectId,
    databaseId,
    region: 'us-central1',
    release: { commitSha: '0'.repeat(40), archiveDigest: `sha256:${'0'.repeat(64)}` },
  };
  const manifest = await readFile(resolve('infra/gcp/firestore/firestore.indexes.json'));
  if (mode === 'apply') {
    const created = await provisionTargetFirestoreIndexes(systemRunner, identity, manifest);
    process.stdout.write(
      `Submitted ${created.indexesCreated} composite indexes and ${created.exemptionsCreated} single-field exemptions. Index builds can take time; run verify after Google reports them READY.\n`,
    );
    return;
  }
  await verifyConsumerIndexReadiness(systemRunner, identity, manifest);
  process.stdout.write(
    `Firestore indexes and single-field exemptions exactly match the shared manifest for ${projectId}/${databaseId}.\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Firestore index operation failed'}\n`,
  );
  process.exitCode = 1;
});
