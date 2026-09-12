import { describe, expect, it } from 'vitest';
import {
  advanceInstallationStage,
  type CreateInstallationManifestInput,
  createInstallationManifest,
  type InstallationManifest,
  type InstallationResource,
  resumeInstallation,
  serializeInstallationManifest,
  validateInstallationManifest,
} from './installation-manifest.js';

const identity = {
  installationId: 'demo-installation',
  projectId: 'demo-project-123',
  region: 'us-west1',
  databaseId: 'demo-db-1234',
  release: {
    commitSha: '0123456789abcdef0123456789abcdef01234567',
    archiveDigest: `sha256:${'abcdef'.repeat(10)}abcd`,
  },
};

const resources: InstallationResource[] = [
  {
    kind: 'firestore-database',
    name: '(default)',
    scope: 'project' as const,
    owner: 'terraform' as const,
    installationId: 'demo-installation',
  },
  {
    kind: 'billing-account',
    name: 'existing-billing',
    scope: 'project' as const,
    owner: 'preexisting' as const,
    installationId: null,
  },
];
function resourceAt(index: number): InstallationResource {
  const resource = resources[index];
  if (!resource) throw new Error(`Missing test resource ${index}`);
  return resource;
}

const terraformResource = resourceAt(0);
const preexistingResource = resourceAt(1);

function input(
  overrides: Partial<CreateInstallationManifestInput> = {},
): CreateInstallationManifestInput {
  return {
    identity,
    modules: ['sms', 'google'],
    modelProvider: 'google',
    resources,
    createdAt: '2026-09-12T12:00:00.000Z',
    ...overrides,
  };
}

function manifest(overrides: Partial<CreateInstallationManifestInput> = {}): InstallationManifest {
  return createInstallationManifest(input(overrides));
}

describe('installation manifest', () => {
  it('canonicalizes modules and resources into deterministic JSON', () => {
    const value = manifest();
    expect(value.selection.modules).toEqual(['google', 'sms']);
    expect(value.resources.map((resource) => resource.kind)).toEqual([
      'billing-account',
      'firestore-database',
    ]);
    expect(JSON.parse(serializeInstallationManifest(value))).toEqual(value);
  });

  it('rejects unsupported schema, modules, duplicate resources, and ownership mismatches', () => {
    expect(() => validateInstallationManifest({ ...manifest(), schemaVersion: 2 })).toThrow(
      'schemaVersion',
    );
    expect(() => manifest({ modules: ['unknown'] })).toThrow('unsupported module');
    expect(() => manifest({ modules: ['sms', 'sms'] })).toThrow('duplicate module');
    expect(() =>
      manifest({
        resources: [...resources, { ...terraformResource, name: '(default)' }],
      }),
    ).toThrow('duplicate resource identity');
    expect(() =>
      manifest({
        resources: [{ ...terraformResource, installationId: 'another-installation' }],
      }),
    ).toThrow('must match the manifest installation');
    expect(() =>
      manifest({
        resources: [
          {
            ...terraformResource,
            name: 'projects/foreign-project/databases/(default)',
          },
        ],
      }),
    ).toThrow('different project');
    expect(() =>
      manifest({
        resources: [{ ...preexistingResource, installationId: 'demo-installation' }],
      }),
    ).toThrow('must be null for preexisting resources');
    expect(() => manifest({ identity: { ...identity, installationId: 'abc' } })).toThrow(
      'identity.installationId',
    );
    expect(() =>
      manifest({ identity: { ...identity, installationId: 'demo-installation-' } }),
    ).toThrow('identity.installationId');
    expect(
      manifest({ identity: { ...identity, databaseId: '(default)' } }).identity.databaseId,
    ).toBe('(default)');
    expect(() =>
      manifest({ identity: { ...identity, databaseId: '123e4567-e89b-12d3-a456-426614174000' } }),
    ).toThrow('identity.databaseId');
    expect(() => manifest({ identity: { ...identity, databaseId: 'db' } })).toThrow(
      'identity.databaseId',
    );
  });

  it('rejects timestamps that parse only by normalizing an impossible calendar date', () => {
    expect(() => manifest({ createdAt: '2026-02-29T12:00:00.000Z' })).toThrow('real calendar date');
    expect(() => manifest({ createdAt: '2026-04-31T12:00:00.000Z' })).toThrow('real calendar date');
    expect(() =>
      validateInstallationManifest({
        ...manifest(),
        stage: { ...manifest().stage, updatedAt: '2026-02-30T12:00:00.000Z' },
      }),
    ).toThrow('real calendar date');
  });

  it('rejects unknown fields so secrets cannot be smuggled into the manifest', () => {
    const value = { ...manifest(), apiKey: 'secret-value' };
    expect(() => validateInstallationManifest(value)).toThrow('unknown field apiKey');
    expect(() =>
      createInstallationManifest({ ...input(), apiKey: 'secret-value' } as never),
    ).toThrow('unknown field apiKey');
    const serialized = serializeInstallationManifest(manifest());
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('apiKey');
  });

  it('requires an ordered stage prefix and advances only one stage at a time', () => {
    const value = manifest();
    expect(() =>
      validateInstallationManifest({
        ...value,
        stage: {
          current: 'provisioned',
          completed: ['previewed', 'provisioned'],
          updatedAt: value.stage.updatedAt,
        },
      }),
    ).toThrow('ordered prefix');
    const authorized = advanceInstallationStage(value, 'authorized', '2026-09-12T12:01:00.000Z');
    expect(authorized.stage.completed).toEqual(['previewed', 'authorized']);
    const bootstrapped = advanceInstallationStage(
      authorized,
      'bootstrapped',
      '2026-09-12T12:02:00.000Z',
    );
    expect(() =>
      advanceInstallationStage(bootstrapped, 'provisioned', '2026-09-12T12:03:00.000Z'),
    ).not.toThrow();
    expect(() => advanceInstallationStage(authorized, 'ready', '2026-09-12T12:02:00.000Z')).toThrow(
      'immediate successor',
    );
  });

  it('is idempotent on resume and stage retry, without mutating the source', () => {
    const value = manifest();
    const snapshot = structuredClone(value);
    const authorized = advanceInstallationStage(value, 'authorized', '2026-09-12T12:01:00.000Z');
    expect(value).toEqual(snapshot);
    expect(advanceInstallationStage(authorized, 'authorized', '2026-09-12T13:00:00.000Z')).toEqual(
      authorized,
    );
    expect(resumeInstallation(authorized, identity, '2026-09-12T14:00:00.000Z')).toEqual(
      authorized,
    );
    expect(() =>
      advanceInstallationStage(authorized, 'authorized', '2026-09-12T12:00:00.000Z'),
    ).toThrow('must not be earlier than');
    expect(() => resumeInstallation(authorized, identity, '2026-09-12T12:00:00.000Z')).toThrow(
      'must not be earlier than',
    );
  });

  it('invalidates instead of rewriting immutable identity on changed resume input', () => {
    const value = manifest();
    const invalidated = resumeInstallation(
      value,
      { ...identity, region: 'europe-west1' },
      '2026-09-12T12:05:00.000Z',
    );
    expect(invalidated.status).toBe('invalidated');
    expect(invalidated.identity).toEqual(value.identity);
    expect(invalidated.invalidation?.reason).toContain('identity changed');
    expect(() =>
      resumeInstallation(
        invalidated,
        { ...identity, region: 'europe-west1' },
        '2026-09-12T12:04:00.000Z',
      ),
    ).toThrow('must not be earlier than');
    expect(() =>
      advanceInstallationStage(invalidated, 'authorized', '2026-09-12T12:06:00.000Z'),
    ).toThrow('invalidated');
    expect(() => resumeInstallation(invalidated, identity, '2026-09-12T12:04:00.000Z')).toThrow(
      'must not be earlier than',
    );
  });

  it('rejects persisted invalidation timestamps older than the completed stage', () => {
    const value = manifest();
    expect(() =>
      validateInstallationManifest({
        ...value,
        status: 'invalidated',
        invalidation: { reason: 'stale', at: '2026-09-12T11:59:00.000Z' },
      }),
    ).toThrow('must not be earlier than');
  });
});
