import { createHash } from 'node:crypto';
import type { MigrationBundle } from '@assistant/persistence';
import { createInstallationStore, type InstallationStore } from './store.js';
import {
  importWorkspaceBundle,
  type WorkspaceImportMode,
  type WorkspaceImportResult,
} from './workspace-migration.js';

const MAX_SNAPSHOT_BYTES = 500_000_000;
type BundleImporter = (
  store: InstallationStore,
  bundle: MigrationBundle,
  options: {
    sourceAgentId: string;
    target: MigrationBundle['manifest']['target'];
    mode: WorkspaceImportMode;
  },
) => Promise<WorkspaceImportResult>;

export interface WorkspaceImportJobEnvironment {
  GCP_PROJECT?: string;
  ASSISTANT_WORKSPACE_ID?: string;
  FIRESTORE_TARGET_DATABASE_ID?: string;
  MIGRATION_SOURCE_AGENT_ID?: string;
  MIGRATION_IMPORT_MODE?: string;
  MIGRATION_SNAPSHOT_URI?: string;
  MIGRATION_SNAPSHOT_GENERATION?: string;
  MIGRATION_SNAPSHOT_SHA256?: string;
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function configuration(env: WorkspaceImportJobEnvironment) {
  const projectId = required(env.GCP_PROJECT, 'GCP_PROJECT');
  const installationId = required(env.ASSISTANT_WORKSPACE_ID, 'ASSISTANT_WORKSPACE_ID');
  if (!/^[a-zA-Z0-9_-]+$/.test(installationId))
    throw new Error('ASSISTANT_WORKSPACE_ID has unsafe path characters');
  const sourceAgentId = required(env.MIGRATION_SOURCE_AGENT_ID, 'MIGRATION_SOURCE_AGENT_ID');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceAgentId))
    throw new Error('MIGRATION_SOURCE_AGENT_ID must be a UUID');
  const mode = required(env.MIGRATION_IMPORT_MODE, 'MIGRATION_IMPORT_MODE');
  if (!['preview', 'write', 'verify'].includes(mode)) throw new Error('Invalid import mode');
  const uri = required(env.MIGRATION_SNAPSHOT_URI, 'MIGRATION_SNAPSHOT_URI');
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  const bucket = `${projectId}-workspace`;
  const prefix = `workspace/${installationId}/migration/snapshots/`;
  const objectName = match?.[2] ?? '';
  if (match?.[1] !== bucket || !objectName.startsWith(prefix) || !objectName.endsWith('.json'))
    throw new Error('Snapshot must belong to this installation workspace bucket');
  const generation = required(env.MIGRATION_SNAPSHOT_GENERATION, 'MIGRATION_SNAPSHOT_GENERATION');
  if (!/^[1-9]\d*$/.test(generation)) throw new Error('Invalid snapshot generation');
  const sha256 = required(env.MIGRATION_SNAPSHOT_SHA256, 'MIGRATION_SNAPSHOT_SHA256');
  if (!/^[0-9a-f]{64}$/i.test(sha256)) throw new Error('Invalid snapshot SHA-256');
  return {
    sourceAgentId,
    mode: mode as WorkspaceImportMode,
    uri,
    bucket,
    objectName,
    generation,
    sha256: sha256.toLowerCase(),
    target: {
      projectId,
      databaseId: required(env.FIRESTORE_TARGET_DATABASE_ID, 'FIRESTORE_TARGET_DATABASE_ID'),
      installationId,
    },
  };
}

/** Downloads one pinned private source generation and delegates strict import/verification. */
export async function runWorkspaceImportJob(
  env: WorkspaceImportJobEnvironment,
  fetcher: typeof fetch = fetch,
  importer: BundleImporter = importWorkspaceBundle,
  storeFactory: typeof createInstallationStore = createInstallationStore,
) {
  const config = configuration(env);
  const tokenResponse = await fetcher(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(10_000) },
  );
  if (!tokenResponse.ok)
    throw new Error(`Cloud Run identity token lookup failed (${tokenResponse.status})`);
  const token = (await tokenResponse.json()) as { access_token?: unknown };
  if (typeof token.access_token !== 'string' || !token.access_token)
    throw new Error('Cloud Run identity did not provide an access token');

  const objectUrl = new URL(
    `https://storage.googleapis.com/storage/v1/b/${config.bucket}/o/${encodeURIComponent(config.objectName)}`,
  );
  objectUrl.searchParams.set('generation', config.generation);
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const metadataResponse = await fetcher(objectUrl, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!metadataResponse.ok)
    throw new Error(`Snapshot metadata lookup failed (${metadataResponse.status})`);
  const metadata = (await metadataResponse.json()) as {
    bucket?: unknown;
    name?: unknown;
    generation?: unknown;
    size?: unknown;
  };
  const size = Number(metadata.size);
  if (
    metadata.bucket !== config.bucket ||
    metadata.name !== config.objectName ||
    metadata.generation !== config.generation ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > MAX_SNAPSHOT_BYTES
  )
    throw new Error('Snapshot metadata does not match the pinned installation object');

  objectUrl.searchParams.set('alt', 'media');
  const dataResponse = await fetcher(objectUrl, {
    headers,
    signal: AbortSignal.timeout(20 * 60_000),
  });
  if (!dataResponse.ok) throw new Error(`Snapshot download failed (${dataResponse.status})`);
  const bytes = Buffer.from(await dataResponse.arrayBuffer());
  if (bytes.length !== size || createHash('sha256').update(bytes).digest('hex') !== config.sha256)
    throw new Error('Snapshot bytes do not match the pinned size and SHA-256');
  const bundle = JSON.parse(bytes.toString('utf8')) as MigrationBundle;
  if (
    bundle.manifest?.formatVersion !== 3 ||
    bundle.manifest.coverage?.complete !== true ||
    bundle.manifest.coverage.omittedTables.length !== 0
  )
    throw new Error('Snapshot must be a complete version 3 source export');
  const store = storeFactory(config.target);
  try {
    const result = await importer(store, bundle, {
      sourceAgentId: config.sourceAgentId,
      target: config.target,
      mode: config.mode,
    });
    return {
      ...result,
      snapshotUri: config.uri,
      snapshotGeneration: config.generation,
      snapshotSha256: config.sha256,
      bundleChecksum: bundle.manifest.bundleChecksum,
    };
  } finally {
    await store.db.terminate();
  }
}
