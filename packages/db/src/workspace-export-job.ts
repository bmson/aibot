import { createHash } from 'node:crypto';
import type { MigrationBundle } from '@assistant/persistence';
import { exportWorkspaceSnapshot, type WorkspaceSnapshotOptions } from './workspace-migration.js';

type SnapshotExporter = (options: WorkspaceSnapshotOptions) => Promise<MigrationBundle>;

export interface WorkspaceExportJobEnvironment {
  DATABASE_URL?: string;
  GCP_PROJECT?: string;
  WORKSPACE_BUCKET?: string;
  ASSISTANT_WORKSPACE_ID?: string;
  CLOUD_RUN_EXECUTION?: string;
  MIGRATION_SOURCE_AGENT_ID?: string;
  FIRESTORE_TARGET_DATABASE_ID?: string;
  MIGRATION_EMBEDDING_PROVIDER?: string;
  MIGRATION_EMBEDDING_MODEL?: string;
  MIGRATION_EMBEDDING_DIMENSIONS?: string;
  MIGRATION_EMBEDDING_REVISION?: string;
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function configuration(env: WorkspaceExportJobEnvironment) {
  const projectId = required(env.GCP_PROJECT, 'GCP_PROJECT');
  const bucket = required(env.WORKSPACE_BUCKET, 'WORKSPACE_BUCKET');
  if (bucket !== `${projectId}-workspace`)
    throw new Error('Migration export must use the installation workspace bucket');
  const installationId = required(env.ASSISTANT_WORKSPACE_ID, 'ASSISTANT_WORKSPACE_ID');
  if (!/^[a-zA-Z0-9_-]+$/.test(installationId))
    throw new Error('ASSISTANT_WORKSPACE_ID has unsafe path characters');
  const execution = required(env.CLOUD_RUN_EXECUTION, 'CLOUD_RUN_EXECUTION');
  if (!/^[a-z0-9-]+$/.test(execution))
    throw new Error('CLOUD_RUN_EXECUTION has unsafe path characters');
  const agentId = required(env.MIGRATION_SOURCE_AGENT_ID, 'MIGRATION_SOURCE_AGENT_ID');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId))
    throw new Error('MIGRATION_SOURCE_AGENT_ID must be a UUID');
  const dimensions = Number(
    required(env.MIGRATION_EMBEDDING_DIMENSIONS, 'MIGRATION_EMBEDDING_DIMENSIONS'),
  );
  if (!Number.isSafeInteger(dimensions) || dimensions < 1)
    throw new Error('MIGRATION_EMBEDDING_DIMENSIONS must be a positive integer');
  return {
    databaseUrl: required(env.DATABASE_URL, 'DATABASE_URL'),
    agentId,
    bucket,
    objectName: `workspace/${installationId}/migration/snapshots/${execution}.json`,
    target: {
      projectId,
      databaseId: required(env.FIRESTORE_TARGET_DATABASE_ID, 'FIRESTORE_TARGET_DATABASE_ID'),
      installationId,
    },
    embeddingSpace: {
      provider: required(env.MIGRATION_EMBEDDING_PROVIDER, 'MIGRATION_EMBEDDING_PROVIDER'),
      model: required(env.MIGRATION_EMBEDDING_MODEL, 'MIGRATION_EMBEDDING_MODEL'),
      dimensions,
      revision: required(env.MIGRATION_EMBEDDING_REVISION, 'MIGRATION_EMBEDDING_REVISION'),
    },
  };
}

/** Runs only in a manually executed Cloud Run job; the source URL stays in Secret Manager. */
export async function runWorkspaceExportJob(
  env: WorkspaceExportJobEnvironment,
  fetcher: typeof fetch = fetch,
  exporter: SnapshotExporter = exportWorkspaceSnapshot,
) {
  const config = configuration(env);
  const bundle = await exporter({
    databaseUrl: config.databaseUrl,
    agentId: config.agentId,
    target: config.target,
    embeddingSpace: config.embeddingSpace,
  });
  const bytes = Buffer.from(JSON.stringify(bundle));
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const tokenResponse = await fetcher(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(10_000) },
  );
  if (!tokenResponse.ok)
    throw new Error(`Cloud Run identity token lookup failed (${tokenResponse.status})`);
  const token = (await tokenResponse.json()) as { access_token?: unknown };
  if (typeof token.access_token !== 'string' || !token.access_token)
    throw new Error('Cloud Run identity did not provide an access token');

  const uploadUrl = new URL(
    `https://storage.googleapis.com/upload/storage/v1/b/${config.bucket}/o`,
  );
  uploadUrl.searchParams.set('uploadType', 'media');
  uploadUrl.searchParams.set('name', config.objectName);
  uploadUrl.searchParams.set('ifGenerationMatch', '0');
  const upload = await fetcher(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
      'Content-Length': String(bytes.length),
    },
    body: bytes,
    signal: AbortSignal.timeout(20 * 60_000),
  });
  if (!upload.ok) throw new Error(`Workspace snapshot upload failed (${upload.status})`);
  return {
    uri: `gs://${config.bucket}/${config.objectName}`,
    records: bundle.records.length,
    bundleChecksum: bundle.manifest.bundleChecksum,
    byteLength: bytes.length,
    sha256,
  };
}
