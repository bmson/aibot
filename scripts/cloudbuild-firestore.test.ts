import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

/** Drop comments and the PostgreSQL-only backup and migration images. */
function withoutPostgresImages(config: string): string {
  const body = config.slice(config.indexOf('steps:\n'));
  return body
    .split(/(?=^ {2}- name: gcr\.io\/cloud-builders\/docker\n)/m)
    .filter((step) => !/infra\/docker\/(backup|migrate)\.Dockerfile/.test(step))
    .join('')
    .split('\n')
    .filter((line) => !/\/(backup|migrate):/.test(line) && !line.trimStart().startsWith('#'))
    .join('\n');
}

describe('Firestore Cloud Build config', () => {
  it('is cloudbuild.yaml without the PostgreSQL backup and migration images', async () => {
    const full = await read('infra/gcp/cloudbuild.yaml');
    const firestore = await read('infra/gcp/cloudbuild-firestore.yaml');
    expect(firestore).not.toMatch(/\/(backup|migrate)[:.]/);
    expect(withoutPostgresImages(firestore)).toBe(withoutPostgresImages(full));
    expect(full).toMatch(/infra\/docker\/backup\.Dockerfile/);
  });

  it('is the build the Firestore release submits', async () => {
    const release = await read('infra/gcp/release-firestore.sh');
    expect(release).toContain('--config infra/gcp/cloudbuild-firestore.yaml');
    expect(release).not.toContain('--config infra/gcp/cloudbuild.yaml');
  });
});
