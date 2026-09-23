import type { MigrationBundle } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import {
  runWorkspaceExportJob,
  type WorkspaceExportJobEnvironment,
} from './workspace-export-job.js';

const env: WorkspaceExportJobEnvironment = {
  DATABASE_URL: 'postgres://private:secret@database.example/assistant',
  GCP_PROJECT: 'customer-project',
  WORKSPACE_BUCKET: 'customer-project-workspace',
  ASSISTANT_WORKSPACE_ID: 'personal_assistant',
  CLOUD_RUN_EXECUTION: 'assistant-export-unique-execution',
  MIGRATION_SOURCE_AGENT_ID: '11111111-1111-4111-8111-111111111111',
  FIRESTORE_TARGET_DATABASE_ID: '(default)',
  MIGRATION_EMBEDDING_PROVIDER: 'openai',
  MIGRATION_EMBEDDING_MODEL: 'text-embedding-3-small',
  MIGRATION_EMBEDDING_DIMENSIONS: '1536',
  MIGRATION_EMBEDDING_REVISION: 'source-v1',
};

const bundle = {
  manifest: {
    bundleChecksum: 'source-checksum',
    coverage: { complete: true, omittedTables: [] },
  },
  records: [{ privateContent: 'never printed' }],
} as unknown as MigrationBundle;

describe('Cloud Run workspace export job', () => {
  it('uploads the complete snapshot once to the installation bucket without exposing credentials', async () => {
    const exporter = vi.fn(async () => bundle);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return requests.length === 1
        ? Response.json({ access_token: 'private-access-token' })
        : Response.json({
            name: new URL(String(input)).searchParams.get('name'),
            bucket: 'customer-project-workspace',
            size: String(Buffer.byteLength(JSON.stringify(bundle))),
            generation: '123456789',
          });
    }) as unknown as typeof fetch;

    const validator = vi.fn();
    const result = await runWorkspaceExportJob(env, fetcher, exporter, validator);
    expect(validator).toHaveBeenCalledWith(bundle, {
      sourceAgentId: env.MIGRATION_SOURCE_AGENT_ID,
      target: {
        projectId: 'customer-project',
        databaseId: '(default)',
        installationId: 'personal_assistant',
      },
    });
    expect(exporter).toHaveBeenCalledWith({
      databaseUrl: env.DATABASE_URL,
      agentId: env.MIGRATION_SOURCE_AGENT_ID,
      target: {
        projectId: 'customer-project',
        databaseId: '(default)',
        installationId: 'personal_assistant',
      },
      embeddingSpace: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        revision: 'source-v1',
      },
    });
    const url = new URL(requests[1]?.url ?? '');
    expect(url.origin).toBe('https://storage.googleapis.com');
    expect(url.searchParams.get('name')).toBe(
      'workspace/personal_assistant/migration/snapshots/assistant-export-unique-execution.json',
    );
    expect(url.searchParams.get('ifGenerationMatch')).toBe('0');
    expect(String(requests[1]?.init?.body)).toContain('never printed');
    expect(JSON.stringify(result)).not.toContain('never printed');
    expect(JSON.stringify(result)).not.toContain('private:secret');
    expect(JSON.stringify(result)).not.toContain('private-access-token');
    expect(result).toMatchObject({
      uri: 'gs://customer-project-workspace/workspace/personal_assistant/migration/snapshots/assistant-export-unique-execution.json',
      records: 1,
      bundleChecksum: 'source-checksum',
      byteLength: expect.any(Number),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      generation: '123456789',
    });
  });

  it('rejects cross-bucket export and incomplete provenance before reading the database', async () => {
    const exporter = vi.fn(async () => bundle);
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(
      runWorkspaceExportJob({ ...env, WORKSPACE_BUCKET: 'different-bucket' }, fetcher, exporter),
    ).rejects.toThrow('installation workspace bucket');
    await expect(
      runWorkspaceExportJob({ ...env, MIGRATION_EMBEDDING_MODEL: '' }, fetcher, exporter),
    ).rejects.toThrow('MIGRATION_EMBEDDING_MODEL is required');
    expect(exporter).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails when storage refuses to create a new generation', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: 'private-access-token' }))
      .mockResolvedValueOnce(
        new Response('private storage diagnostics', { status: 412 }),
      ) as typeof fetch;
    await expect(runWorkspaceExportJob(env, fetcher, async () => bundle, vi.fn())).rejects.toThrow(
      'Workspace snapshot upload failed (412)',
    );
  });

  it('refuses an incomplete source inventory before requesting storage access', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const incomplete = {
      ...bundle,
      manifest: {
        ...bundle.manifest,
        coverage: { complete: false, omittedTables: ['new_source_table'] },
      },
    } as MigrationBundle;
    await expect(
      runWorkspaceExportJob(env, fetcher, async () => incomplete, vi.fn()),
    ).rejects.toThrow('does not cover every source table');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects mismatched upload metadata instead of reporting success', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: 'private-access-token' }))
      .mockResolvedValueOnce(
        Response.json({
          name: 'different-object',
          bucket: 'customer-project-workspace',
          size: '1',
          generation: '123456789',
        }),
      ) as typeof fetch;
    await expect(runWorkspaceExportJob(env, fetcher, async () => bundle, vi.fn())).rejects.toThrow(
      'mismatched object metadata',
    );
  });

  it('rejects a bundle that fails canonical checksum and vector validation before upload', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const validator = vi.fn(() => {
      throw new Error('Invalid migration bundle');
    });
    await expect(
      runWorkspaceExportJob(env, fetcher, async () => bundle, validator),
    ).rejects.toThrow('Invalid migration bundle');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
