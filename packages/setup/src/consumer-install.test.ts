import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { provisionConsumerInstallation } from './consumer-install.js';
import { advanceInstallationStage, createInstallationManifest } from './installation-manifest.js';
import { sha256File } from './installation-provenance.js';
import type { CommandRunner } from './runner.js';

const execFileAsync = promisify(execFile);
const requiredServiceRows = [
  'artifactregistry.googleapis.com',
  'firestore.googleapis.com',
  'iam.googleapis.com',
  'iamcredentials.googleapis.com',
  'serviceusage.googleapis.com',
  'storage.googleapis.com',
  'aiplatform.googleapis.com',
].map((name) => ({ config: { name } }));

async function foundationArchive(path: string): Promise<void> {
  await execFileAsync(
    'tar',
    [
      '-czf',
      path,
      '-C',
      process.cwd(),
      'infra/gcp/consumer/terraform/main.tf',
      'infra/gcp/consumer/terraform/variables.tf',
      'infra/gcp/consumer/terraform/outputs.tf',
      'infra/gcp/consumer/terraform/versions.tf',
      'infra/gcp/consumer/terraform/.terraform.lock.hcl',
    ],
    { env: { ...process.env, COPYFILE_DISABLE: '1' } },
  );
}

function manifest(digest: string) {
  return createInstallationManifest({
    identity: {
      installationId: 'consumer-install',
      projectId: 'customer-project',
      region: 'us-central1',
      databaseId: '(default)',
      release: {
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        archiveDigest: digest,
      },
    },
    modules: [],
    modelProvider: 'google',
    resources: [],
    createdAt: '2026-09-12T12:00:00.000Z',
  });
}

function fakeRunner(
  log: string[],
  describeBucket = false,
  firestoreList = '[]',
  terraformOutput: unknown = {
    project_id: { value: 'customer-project' },
    installation_id: { value: 'consumer-install' },
    region: { value: 'us-central1' },
    firestore_database_name: { value: '(default)' },
    assets_bucket_name: { value: 'customer-project-consumer-install-assets' },
    source_bucket_name: { value: 'customer-project-consumer-install-source' },
    artifact_registry_repository: {
      value: 'projects/customer-project/locations/us-central1/repositories/consumer-install',
    },
    runtime_service_account_email: {
      value: 'consumer-install-runtime@customer-project.iam.gserviceaccount.com',
    },
  },
  foreignBucket = false,
  receiptDigest = '',
): CommandRunner {
  return {
    async run(command, args) {
      log.push([command, ...args].join(' '));
      if (command === 'gcloud' && args[0] === 'projects') {
        return { ok: true, stdout: 'customer-project', stderr: '' };
      }
      if (command === 'gcloud' && args[0] === 'services') {
        return { ok: true, stdout: JSON.stringify(requiredServiceRows), stderr: '' };
      }
      if (command === 'gcloud' && args[0] === 'firestore') {
        return { ok: true, stdout: firestoreList, stderr: '' };
      }
      if (
        command === 'gcloud' &&
        args[0] === 'storage' &&
        args[1] === 'buckets' &&
        args[2] === 'describe'
      ) {
        return describeBucket
          ? {
              ok: true,
              stdout: JSON.stringify({
                labels: foreignBucket
                  ? { installation: 'other', managed_by: 'terraform' }
                  : {
                      installation: 'consumer-install',
                      managed_by: 'assistant-consumer-bootstrap',
                    },
              }),
              stderr: '',
            }
          : { ok: false, stdout: '', stderr: 'NOT_FOUND' };
      }
      if (
        command === 'gcloud' &&
        args[0] === 'storage' &&
        args[1] === 'objects' &&
        args[2] === 'describe'
      ) {
        return describeBucket
          ? {
              ok: true,
              stdout: JSON.stringify({
                metadata: {
                  assistant_installation: foreignBucket ? 'other' : 'consumer-install',
                  assistant_archive_digest: receiptDigest,
                },
              }),
              stderr: '',
            }
          : { ok: false, stdout: '', stderr: 'NOT_FOUND' };
      }
      if (command === 'terraform' && args.includes('output')) {
        return { ok: true, stdout: JSON.stringify(terraformOutput), stderr: '' };
      }
      return { ok: true, stdout: '{}', stderr: '' };
    },
  };
}

describe('consumer installation', () => {
  it('dry-run verifies the archive and absence without provisioning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-'));
    const archive = join(dir, 'release.tar.gz');
    const state = join(dir, 'state.json');
    await foundationArchive(archive);
    const digest = await sha256File(archive);
    const log: string[] = [];
    const result = await provisionConsumerInstallation(
      { runner: fakeRunner(log) },
      {
        manifest: manifest(digest),
        archivePath: archive,
        statePath: state,
        terraformDir: 'infra/gcp/consumer/terraform',
        stateBucket: 'customer-project-consumer-install-state',
        apply: false,
      },
    );
    expect(result.applied).toBe(false);
    expect(result.runtimeReady).toBe(false);
    expect(log.some((entry) => entry.includes('terraform'))).toBe(false);
    await expect(readFile(state)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('applies foundation stages and leaves readiness gated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-'));
    const archive = join(dir, 'release.tar.gz');
    const state = join(dir, 'state.json');
    await foundationArchive(archive);
    const digest = await sha256File(archive);
    const log: string[] = [];
    const terraformLog: string[] = [];
    const result = await provisionConsumerInstallation(
      { runner: fakeRunner(log), terraform: fakeRunner(terraformLog) },
      {
        manifest: manifest(digest),
        archivePath: archive,
        statePath: state,
        terraformDir: 'infra/gcp/consumer/terraform',
        stateBucket: 'customer-project-consumer-install-state',
        apply: true,
        now: (() => {
          let seconds = 0;
          return () => `2026-09-12T12:00:0${String(++seconds)}.000Z`;
        })(),
      },
    );
    expect(result.manifest.stage.current).toBe('provisioned');
    expect(result.runtimeReady).toBe(false);
    expect(result.pending).toEqual(['initialized', 'ready']);
    expect(log.some((entry) => entry.includes('storage cp'))).toBe(true);
    expect(terraformLog.some((entry) => entry.includes('apply -auto-approve'))).toBe(true);
    expect(JSON.parse(await readFile(state, 'utf8')).stage.current).toBe('provisioned');
  });

  it('fails closed when a state bucket exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-'));
    const archive = join(dir, 'release.tar.gz');
    await foundationArchive(archive);
    const digest = await sha256File(archive);
    await expect(
      provisionConsumerInstallation(
        { runner: fakeRunner([], true, '[]', undefined, true) },
        {
          manifest: manifest(digest),
          archivePath: archive,
          statePath: join(dir, 'state.json'),
          terraformDir: 'infra/gcp/consumer/terraform',
          stateBucket: 'customer-project-consumer-install-state',
          apply: true,
        },
      ),
    ).rejects.toThrow('Refusing to adopt');
  });

  it('rejects malformed or existing database listings before apply', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-'));
    const archive = join(dir, 'release.tar.gz');
    await foundationArchive(archive);
    const digest = await sha256File(archive);
    const options = {
      manifest: manifest(digest),
      archivePath: archive,
      statePath: join(dir, 'state.json'),
      terraformDir: 'infra/gcp/consumer/terraform',
      stateBucket: 'customer-project-consumer-install-state',
      apply: true,
    } as const;
    await expect(
      provisionConsumerInstallation({ runner: fakeRunner([], false, '{}') }, options),
    ).rejects.toThrow('malformed JSON');
    await expect(
      provisionConsumerInstallation(
        {
          runner: fakeRunner(
            [],
            false,
            '[{"name":"projects/customer-project/databases/(default)"}]',
          ),
        },
        options,
      ),
    ).rejects.toThrow('Refusing to adopt existing Firestore database');
  });

  it('rejects state bucket changes and fabricated advanced manifests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-'));
    const archive = join(dir, 'release.tar.gz');
    await foundationArchive(archive);
    const digest = await sha256File(archive);
    const base = {
      archivePath: archive,
      statePath: join(dir, 'state.json'),
      terraformDir: 'infra/gcp/consumer/terraform',
      apply: false,
    } as const;
    await expect(
      provisionConsumerInstallation(
        { runner: fakeRunner([]) },
        { ...base, manifest: manifest(digest), stateBucket: 'foreign-state-bucket' },
      ),
    ).rejects.toThrow('State bucket must be');
    const advanced = advanceInstallationStage(
      manifest(digest),
      'authorized',
      '2026-09-12T12:01:00.000Z',
    );
    await expect(
      provisionConsumerInstallation(
        { runner: fakeRunner([]) },
        { ...base, manifest: advanced, stateBucket: 'customer-project-consumer-install-state' },
      ),
    ).rejects.toThrow('advanced manifest');
  });

  it('resumes after bucket creation and upload failure using owned labels', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-'));
    const archive = join(dir, 'release.tar.gz');
    const state = join(dir, 'state.json');
    await foundationArchive(archive);
    const digest = await sha256File(archive);
    const base = {
      manifest: manifest(digest),
      archivePath: archive,
      statePath: state,
      terraformDir: 'infra/gcp/consumer/terraform',
      stateBucket: 'customer-project-consumer-install-state',
      apply: true,
    } as const;
    const first = fakeRunner([]);
    const original = first.run;
    first.run = async (command, args) => {
      if (command === 'gcloud' && args[0] === 'storage' && args[1] === 'cp')
        return { ok: false, stdout: '', stderr: 'upload failed' };
      return original(command, args);
    };
    await expect(provisionConsumerInstallation({ runner: first }, base)).rejects.toThrow(
      'upload failed',
    );
    expect(JSON.parse(await readFile(state, 'utf8')).stage.current).toBe('authorized');
    const resumed = await provisionConsumerInstallation(
      { runner: fakeRunner([], true, '[]', undefined, false, digest) },
      base,
    );
    expect(resumed.manifest.stage.current).toBe('provisioned');
  });

  it('rejects invalid Terraform output without exposing command details', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-'));
    const archive = join(dir, 'release.tar.gz');
    await foundationArchive(archive);
    const digest = await sha256File(archive);
    await expect(
      provisionConsumerInstallation(
        { runner: fakeRunner([], false, '[]', {}) },
        {
          manifest: manifest(digest),
          archivePath: archive,
          statePath: join(dir, 'state.json'),
          terraformDir: 'infra/gcp/consumer/terraform',
          stateBucket: 'customer-project-consumer-install-state',
          apply: true,
        },
      ),
    ).rejects.toThrow('Terraform output missing project_id');
  });
});
