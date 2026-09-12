import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { CreateInstallationManifestInput } from './installation-manifest.js';
import { previewInstallation } from './installation-plan.js';

const execFileAsync = promisify(execFile);

const base: CreateInstallationManifestInput = {
  identity: {
    installationId: 'preview-installation',
    projectId: 'preview-project-123',
    region: 'us-west1',
    databaseId: 'assistant-db',
    release: {
      commitSha: '0123456789abcdef0123456789abcdef01234567',
      archiveDigest: `sha256:${'1234567890abcdef'.repeat(4)}`,
    },
  },
  modules: ['sms', 'google'],
  modelProvider: 'google',
  resources: [
    {
      kind: 'source-bucket',
      name: 'preview-installation-source',
      scope: 'installation',
      owner: 'bootstrap',
      installationId: 'preview-installation',
    },
  ],
  createdAt: '2026-09-12T12:00:00.000Z',
};

describe('offline installation preview', () => {
  it('is deterministic, preview-only, and runtime-gated', () => {
    const first = previewInstallation(base);
    const second = previewInstallation({ ...base, modules: ['google', 'sms'] });
    expect(first).toEqual(second);
    expect(first.mode).toBe('preview-only');
    expect(first.runtimeGated).toBe(true);
    expect(first.blockers.join('\n')).toContain('no cloud checks');
    expect(first.blockers.join('\n')).toContain('Firestore application and dispatcher composition');
    expect(first.blockers.join('\n')).toContain('Google model and passkey/recovery runtime');
    expect(first.blockers.join('\n')).toContain('Terraform/bootstrap implementation is incomplete');
    expect(first.blockers.join('\n')).toContain('live provisioning, IAM');
    expect(first.blockers.join('\n')).toContain('provider labels');
    expect(first.blockers.join('\n')).not.toContain('installation is ready');
    expect(first.deploymentPlan.modules).toEqual(['google', 'sms']);
    expect(first.deploymentPlan.gcpApis).toContain('gmail.googleapis.com');
    expect(first.baseGcpApiIntent).toEqual([
      'artifactregistry.googleapis.com',
      'cloudbuild.googleapis.com',
      'cloudtasks.googleapis.com',
      'firestore.googleapis.com',
      'run.googleapis.com',
      'secretmanager.googleapis.com',
      'storage.googleapis.com',
      'aiplatform.googleapis.com',
    ]);
  });

  it('derives the plan from explicit modules without loading credentials or running commands', () => {
    const result = previewInstallation({ ...base, modules: [], modelProvider: 'openrouter' });
    expect(result.deploymentPlan.modules).toEqual([]);
    expect(result.deploymentPlan.gcpApis).toEqual([]);
    expect(result.deploymentPlan.schedulerJobs).toEqual([]);
    expect(result.baseGcpApiIntent).not.toContain('aiplatform.googleapis.com');
  });

  it('keeps the pure installation entrypoint from loading a repository .env', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'assistant-install-preview-'));
    await writeFile(path.join(temporaryRoot, '.env'), 'OPENROUTER_API_KEY=preview-import-secret\n');
    try {
      const childEnv: NodeJS.ProcessEnv = { ...process.env, ASSISTANT_REPO_ROOT: temporaryRoot };
      delete childEnv.OPENROUTER_API_KEY;
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          "await import('@assistant/setup/installation'); process.stdout.write(process.env.OPENROUTER_API_KEY ?? '')",
        ],
        { cwd: path.resolve(import.meta.dirname, '../../..'), env: childEnv },
      );
      expect(stdout).toBe('');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
