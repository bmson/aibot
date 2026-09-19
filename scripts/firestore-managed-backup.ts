import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import firestore from '@google-cloud/firestore';
import {
  createManagedFirestoreBackup,
  type ManagedBackupManifest,
  ManagedFirestoreDataClient,
  restoreManagedFirestoreBackup,
  type VerifiedGcsObject,
} from '../packages/firestore/src/managed-backup.js';
import { createGcloudAuthClient } from './gcloud-auth.js';

const { values } = parseArgs({
  options: {
    help: { type: 'boolean' },
    backup: { type: 'boolean' },
    restore: { type: 'boolean' },
    execute: { type: 'boolean' },
    'gcloud-auth': { type: 'boolean', default: false },
    'project-id': { type: 'string' },
    'database-id': { type: 'string' },
    'installation-id': { type: 'string' },
    location: { type: 'string' },
    'gcs-prefix': { type: 'string' },
    'snapshot-time': { type: 'string' },
    manifest: { type: 'string' },
  },
  strict: true,
});

if (values.help) {
  console.log(
    'Plan or execute an official managed Firestore backup/restore. Exactly one of --backup or --restore is required; --execute permits cloud operations.',
  );
  process.exit(0);
}
if (Boolean(values.backup) === Boolean(values.restore))
  throw new Error('Choose exactly one of --backup or --restore');
const projectId = values['project-id'];
const databaseId = values['database-id'];
const installationId = values['installation-id'];
const manifestPath = values.manifest;
if (!projectId || !databaseId || !installationId || !manifestPath)
  throw new Error('--project-id, --database-id, --installation-id, and --manifest are required');

if (!values.execute) {
  console.log(
    JSON.stringify(
      {
        mode: 'preview',
        action: values.backup ? 'managed-backup' : 'managed-restore',
        projectId,
        databaseId,
        installationId,
        manifest: manifestPath,
        gcsPrefix: values['gcs-prefix'] ?? null,
        snapshotTime: values['snapshot-time'] ?? null,
        writes: 'none',
        authentication: values['gcloud-auth']
          ? 'active-gcloud-account'
          : 'application-default-credentials',
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error('Managed Firestore backup/restore refuses emulator routing');

const authClient = values['gcloud-auth'] ? await createGcloudAuthClient() : undefined;
const admin = new firestore.v1.FirestoreAdminClient({ projectId, authClient });
const dataClient = ManagedFirestoreDataClient.create({ projectId, databaseId }, authClient);

function parseGcsUri(uri: string): { bucket: string; object: string } {
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match?.[1] || !match[2]) throw new Error('Invalid GCS object URI');
  return { bucket: match[1], object: match[2] };
}

async function listObjects(uri: string): Promise<VerifiedGcsObject[]> {
  const { bucket, object } = parseGcsUri(uri);
  const token = await (authClient ?? admin.auth).getAccessToken();
  if (!token) throw new Error('Application Default Credentials did not provide an access token');
  const result: VerifiedGcsObject[] = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({
      prefix: `${object}/`,
      fields: 'nextPageToken,items(bucket,name,generation,size,crc32c)',
    });
    if (pageToken) query.set('pageToken', pageToken);
    const response = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o?${query}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!response.ok) throw new Error(`GCS object inventory failed with HTTP ${response.status}`);
    const body = (await response.json()) as {
      nextPageToken?: string;
      items?: Array<{
        bucket?: string;
        name?: string;
        generation?: string;
        size?: string;
        crc32c?: string;
      }>;
    };
    for (const item of body.items ?? []) {
      if (
        item.bucket !== bucket ||
        !item.name?.startsWith(`${object}/`) ||
        !item.generation ||
        !item.size ||
        !item.crc32c
      )
        throw new Error('GCS object inventory returned incomplete metadata');
      result.push({
        uri: `gs://${bucket}/${item.name}`,
        generation: item.generation,
        size: item.size,
        crc32c: item.crc32c,
      });
    }
    pageToken = body.nextPageToken;
  } while (pageToken);
  return result;
}

try {
  if (values.backup) {
    if (!values['gcs-prefix']) throw new Error('--backup requires --gcs-prefix');
    if (!values['snapshot-time']) throw new Error('--backup requires --snapshot-time');
    const manifest = await createManagedFirestoreBackup({
      admin,
      dataClient,
      source: { projectId, databaseId, installationId },
      outputUriPrefix: values['gcs-prefix'],
      snapshotTime: new Date(values['snapshot-time']),
      listObjects,
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(
      JSON.stringify(
        {
          mode: 'backup',
          completed: true,
          operationName: manifest.export.operationName,
          documents: manifest.inventory.documents,
          canonicalHash: manifest.inventory.canonicalHash,
          manifest: manifestPath,
        },
        null,
        2,
      ),
    );
  } else {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ManagedBackupManifest;
    if (!values.location) throw new Error('--restore requires --location');
    const result = await restoreManagedFirestoreBackup({
      admin,
      dataClient,
      target: { projectId, databaseId, installationId },
      manifest,
      location: values.location,
      listObjects,
    });
    console.log(
      JSON.stringify(
        {
          mode: 'restore',
          completed: result.completed,
          operationName: result.operationName,
          documents: result.inventory.documents,
          canonicalHash: result.inventory.canonicalHash,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await Promise.allSettled([dataClient.db.close?.(), admin.close()]);
}
