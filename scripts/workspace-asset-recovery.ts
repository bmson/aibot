import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { MigrationBundle } from '../packages/persistence/src/migration.js';
import { validateMigrationBundle } from '../packages/persistence/src/migration.js';
import { createGcloudAuthClient } from './gcloud-auth.js';
import { migrationAssetReferences } from './workspace-asset-audit.js';

type ObjectRef = { bucket: string; name: string; generation: string };

export type AssetRecoveryManifest = {
  destinationPrefix: string;
  recovered: Array<{
    sourceRecordId: string;
    destination: { objectUri: string; generation: string; bytes: number; sha256: string };
    verified: boolean;
    createOnly: boolean;
  }>;
  missing: Array<{ sourceRecordId: string; classification: string }>;
};

export type AssetRecoveryStorage = {
  stat(ref: Omit<ObjectRef, 'generation'> & { generation?: string }): Promise<{
    generation: string;
    size: number;
  } | null>;
  sha256(ref: ObjectRef): Promise<string>;
  copyCreateOnly(source: ObjectRef, destination: Omit<ObjectRef, 'generation'>): Promise<string>;
};

export type AssetRecoveryResult = {
  references: number;
  recoverableReferences: number;
  unresolvedReferences: number;
  plannedCopies: number;
  copied: number;
  alreadyPresent: number;
  sourceBytesVerified: number;
  bytesVerified: number;
};

function parseGsUri(uri: string): { bucket: string; name: string } {
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match?.[1] || !match[2]) throw new Error('Recovery manifest contains an invalid GCS URI');
  return { bucket: match[1], name: match[2] };
}

function validGeneration(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}

function validDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/**
 * Restore only explicitly verified recovery objects to missing live paths.
 * Existing paths are hashed and accepted only when identical; they are never overwritten.
 */
export async function recoverWorkspaceAssets(
  bundle: MigrationBundle,
  manifest: AssetRecoveryManifest,
  storage: AssetRecoveryStorage,
  options: { targetBucket: string; recoveryPrefix: string; run?: boolean },
): Promise<AssetRecoveryResult> {
  if (![1, 2, 3].includes(bundle.manifest.formatVersion))
    throw new Error('Workspace asset recovery requires a supported migration bundle');
  if (!/^gs:\/\/[^/]+\/.+\/$/.test(options.recoveryPrefix))
    throw new Error('Recovery prefix must be a non-root gs:// prefix ending in /');
  if (manifest.destinationPrefix !== options.recoveryPrefix)
    throw new Error('Recovery manifest prefix does not match the trusted prefix');
  const installationId = bundle.manifest.target.installationId;
  if (!/^[a-zA-Z0-9_-]+$/.test(installationId)) throw new Error('Invalid installation ID');

  // Recovery is keyed to explicit record IDs and paths, so it can repair the
  // rehearsal's older trusted export as well as the final version-3 bundle.
  // The broader audit still requires v3 to prove complete schema coverage.
  const references = migrationAssetReferences(bundle, { requireVersion3: false });
  const referencesById = new Map(references.map((reference) => [reference.id, reference]));
  if (referencesById.size !== references.length)
    throw new Error('Migration bundle contains duplicate asset reference IDs');
  const recoveredById = new Map<string, AssetRecoveryManifest['recovered'][number]>();
  for (const entry of manifest.recovered) {
    if (recoveredById.has(entry.sourceRecordId))
      throw new Error('Recovery manifest contains duplicate record IDs');
    if (!entry.verified || !entry.createOnly)
      throw new Error('Recovery manifest contains an unverified source');
    if (
      !validGeneration(entry.destination.generation) ||
      !Number.isSafeInteger(entry.destination.bytes) ||
      entry.destination.bytes < 0 ||
      !validDigest(entry.destination.sha256)
    )
      throw new Error('Recovery manifest contains invalid source evidence');
    if (!entry.destination.objectUri.startsWith(options.recoveryPrefix))
      throw new Error('Recovery source is outside the trusted prefix');
    if (!referencesById.has(entry.sourceRecordId))
      throw new Error('Recovery manifest references an unknown migration record');
    recoveredById.set(entry.sourceRecordId, entry);
  }
  const missingIds = new Set<string>();
  for (const entry of manifest.missing) {
    if (
      missingIds.has(entry.sourceRecordId) ||
      recoveredById.has(entry.sourceRecordId) ||
      !referencesById.has(entry.sourceRecordId)
    )
      throw new Error('Recovery manifest contains an invalid unresolved record');
    missingIds.add(entry.sourceRecordId);
  }

  let plannedCopies = 0;
  let copied = 0;
  let alreadyPresent = 0;
  let sourceBytesVerified = 0;
  let bytesVerified = 0;
  for (const [recordId, entry] of recoveredById) {
    const reference = referencesById.get(recordId);
    if (!reference) throw new Error('Recovery reference disappeared');
    const sourceUri = parseGsUri(entry.destination.objectUri);
    const source: ObjectRef = { ...sourceUri, generation: entry.destination.generation };
    const sourceMetadata = await storage.stat(source);
    if (
      !sourceMetadata ||
      sourceMetadata.generation !== source.generation ||
      sourceMetadata.size !== entry.destination.bytes ||
      (await storage.sha256(source)) !== entry.destination.sha256
    )
      throw new Error('Pinned recovery source no longer matches its evidence');
    sourceBytesVerified += sourceMetadata.size;

    const destination = {
      bucket: options.targetBucket,
      name: `workspace/${installationId}/${reference.path}`,
    };
    const current = await storage.stat(destination);
    if (current) {
      const currentDigest = await storage.sha256({
        ...destination,
        generation: current.generation,
      });
      if (current.size !== entry.destination.bytes || currentDigest !== entry.destination.sha256)
        throw new Error('Existing live asset conflicts with recovered source');
      alreadyPresent++;
      bytesVerified += current.size;
      continue;
    }

    plannedCopies++;
    if (!options.run) continue;
    const generation = await storage.copyCreateOnly(source, destination);
    const restored = await storage.stat({ ...destination, generation });
    if (
      !restored ||
      restored.generation !== generation ||
      restored.size !== entry.destination.bytes ||
      (await storage.sha256({ ...destination, generation })) !== entry.destination.sha256
    )
      throw new Error('Recovered live asset failed post-copy verification');
    copied++;
    bytesVerified += restored.size;
  }

  return {
    references: references.length,
    recoverableReferences: recoveredById.size,
    unresolvedReferences: missingIds.size,
    plannedCopies,
    copied,
    alreadyPresent,
    sourceBytesVerified,
    bytesVerified,
  };
}

export async function createGcsStorage(token: string): Promise<AssetRecoveryStorage> {
  const headers = { authorization: `Bearer ${token}` };
  const metadataUrl = (bucket: string, name: string, generation?: string) => {
    const url = new URL(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}`,
    );
    if (generation) url.searchParams.set('generation', generation);
    return url;
  };
  return {
    async stat(ref) {
      const response = await fetch(metadataUrl(ref.bucket, ref.name, ref.generation), { headers });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`GCS metadata read failed with HTTP ${response.status}`);
      const body = (await response.json()) as { generation?: string; size?: string };
      if (!body.generation || !body.size || !/^\d+$/.test(body.size))
        throw new Error('GCS returned incomplete object metadata');
      return { generation: body.generation, size: Number(body.size) };
    },
    async sha256(ref) {
      const url = metadataUrl(ref.bucket, ref.name, ref.generation);
      url.searchParams.set('alt', 'media');
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(10 * 60_000) });
      if (!response.ok) throw new Error(`GCS content read failed with HTTP ${response.status}`);
      const hash = createHash('sha256');
      for await (const chunk of response.body ?? []) hash.update(chunk);
      return hash.digest('hex');
    },
    async copyCreateOnly(source, destination) {
      let rewriteToken: string | undefined;
      for (;;) {
        const url = new URL(
          `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(source.bucket)}/o/${encodeURIComponent(source.name)}/rewriteTo/b/${encodeURIComponent(destination.bucket)}/o/${encodeURIComponent(destination.name)}`,
        );
        url.searchParams.set('sourceGeneration', source.generation);
        url.searchParams.set('ifGenerationMatch', '0');
        if (rewriteToken) url.searchParams.set('rewriteToken', rewriteToken);
        const response = await fetch(url, { method: 'POST', headers });
        if (response.status === 412) throw new Error('Live asset appeared before create-only copy');
        if (!response.ok)
          throw new Error(`GCS create-only copy failed with HTTP ${response.status}`);
        const body = (await response.json()) as {
          done?: boolean;
          rewriteToken?: string;
          resource?: { generation?: string };
        };
        if (body.done) {
          if (!body.resource?.generation)
            throw new Error('GCS copy omitted destination generation');
          return body.resource.generation;
        }
        if (!body.rewriteToken) throw new Error('GCS copy omitted rewrite continuation token');
        rewriteToken = body.rewriteToken;
      }
    },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      bundle: { type: 'string' },
      manifest: { type: 'string' },
      'target-bucket': { type: 'string' },
      'recovery-prefix': { type: 'string' },
      run: { type: 'boolean', default: false },
      'gcloud-auth': { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (!values.bundle || !values.manifest || !values['target-bucket'] || !values['recovery-prefix'])
    throw new Error('--bundle, --manifest, --target-bucket, and --recovery-prefix are required');
  const bundle = JSON.parse(await readFile(values.bundle, 'utf8')) as MigrationBundle;
  validateMigrationBundle(bundle, {
    sourceAgentId: bundle.manifest.source.agentId,
    target: bundle.manifest.target,
  });
  if (bundle.manifest.mode !== 'export') throw new Error('Expected an export migration bundle');
  const manifest = JSON.parse(await readFile(values.manifest, 'utf8')) as AssetRecoveryManifest;
  const authClient = values['gcloud-auth'] ? await createGcloudAuthClient() : undefined;
  const { GoogleAuth } = await import('google-auth-library');
  const auth =
    authClient ??
    (await new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/devstorage.read_write'],
    }).getClient());
  const token = (await auth.getAccessToken())?.token;
  if (!token) throw new Error('Google authentication did not provide an access token');
  const result = await recoverWorkspaceAssets(bundle, manifest, await createGcsStorage(token), {
    targetBucket: values['target-bucket'],
    recoveryPrefix: values['recovery-prefix'],
    run: values.run,
  });
  console.log(
    JSON.stringify({ mode: values.run ? 'create-only-copy' : 'preview', ...result }, null, 2),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
