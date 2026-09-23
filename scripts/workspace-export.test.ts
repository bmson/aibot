import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const sha = 'a'.repeat(40);
const tmpPaths: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  for (const path of tmpPaths.splice(0)) await rm(path, { recursive: true, force: true });
});

function runExport(deployedSha = sha) {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-export-test-'));
  tmpPaths.push(directory);
  const callsFile = join(directory, 'calls.jsonl');
  const gcloud = join(directory, 'gcloud');
  writeFileSync(
    gcloud,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS_FILE, JSON.stringify(args) + '\\n');
if (args[0] === 'run' && args[1] === 'services' && args[2] === 'describe') {
  process.stdout.write(JSON.stringify({spec:{template:{spec:{containers:[{env:[
    {name:'WORKSPACE_BUCKET',value:'customer-project-workspace'},
    {name:'ASSISTANT_WORKSPACE_ID',value:'personal_assistant'}
  ]}]}}}}));
} else if (args[0] === 'run' && args[1] === 'jobs' && args[2] === 'describe') {
  if (args[3] === 'assistant-workspace-export') process.exit(1);
  process.stdout.write(JSON.stringify({spec:{template:{spec:{template:{spec:{containers:[{
    image:'us-west1-docker.pkg.dev/customer-project/assistant/migrate:${deployedSha}'
  }]}}}}}}));
}
`,
    { mode: 0o755 },
  );
  const result = spawnSync('bash', ['infra/gcp/workspace-export.sh'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      TEST_CALLS_FILE: callsFile,
      GCP_PROJECT: 'customer-project',
      GCP_REGION: 'us-west1',
      ARTIFACT_REPOSITORY: 'assistant',
      EXPORT_RELEASE_SHA: sha,
      MIGRATION_SOURCE_AGENT_ID: '11111111-1111-4111-8111-111111111111',
      MIGRATION_EMBEDDING_PROVIDER: 'openai',
      MIGRATION_EMBEDDING_MODEL: 'text-embedding-3-small',
      MIGRATION_EMBEDDING_DIMENSIONS: '1536',
      MIGRATION_EMBEDDING_REVISION: 'source-v1',
      FIRESTORE_TARGET_DATABASE_ID: '(default)',
    },
  });
  const calls = readFileSync(callsFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[]);
  return { result, calls };
}

describe('workspace export Cloud Run launcher', () => {
  it('creates and executes a dedicated job from the exact released migration image', () => {
    const { result, calls } = runExport();
    expect(result.status).toBe(0);
    const create = calls.find((args) => args[2] === 'create');
    expect(create).toContain('assistant-workspace-export');
    expect(create).toContain('--set-secrets');
    expect(create).toContain('DATABASE_URL=database-url:latest');
    expect(create).toContain('--args=--filter,@assistant/db,workspace-export-job');
    expect(calls.some((args) => args[2] === 'execute')).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('private:secret');
  });

  it('refuses a snapshot when the deployed migration image is not the requested release', () => {
    const { result, calls } = runExport('b'.repeat(40));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not use the requested commit image');
    expect(calls.some((args) => args[2] === 'create' || args[2] === 'execute')).toBe(false);
  });
});
