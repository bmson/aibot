import { Timestamp } from '@google-cloud/firestore';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { firestoreAuditTarget, readAuditRows } from './llm-audit-source.js';

const fake = vi.hoisted(() => ({
  get: vi.fn(),
  terminate: vi.fn(),
  create: vi.fn(),
  collection: vi.fn(),
  where: vi.fn(),
  orderBy: vi.fn(),
  select: vi.fn(),
}));
vi.mock('@assistant/firestore', async (original) => ({
  ...(await original<typeof import('@assistant/firestore')>()),
  createInstallationStore: fake.create,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const target = {
  GCP_PROJECT: 'audit-project',
  FIRESTORE_DATABASE_ID: 'production',
  ASSISTANT_WORKSPACE_ID: 'owner-workspace',
};

describe('Firestore LLM audit', () => {
  it('requires all target settings rather than silently reading a default database', () => {
    for (const key of Object.keys(target)) {
      expect(() => firestoreAuditTarget({ ...target, [key]: ' ' }, true)).toThrow(
        'requires GCP_PROJECT',
      );
    }
    expect(firestoreAuditTarget(target, true)).toEqual({
      projectId: 'audit-project',
      databaseId: 'production',
      installationId: 'owner-workspace',
    });
    expect(() =>
      firestoreAuditTarget({ ...target, FIRESTORE_EMULATOR_HOST: 'localhost:8080' }, true),
    ).toThrow('Unset FIRESTORE_EMULATOR_HOST');
  });

  function setup() {
    for (const [key, value] of Object.entries(target)) vi.stubEnv(key, value);
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '');
    const query = { where: fake.where, orderBy: fake.orderBy, select: fake.select, get: fake.get };
    fake.collection.mockReturnValue(query);
    fake.where.mockReturnValue(query);
    fake.orderBy.mockReturnValue(query);
    fake.select.mockReturnValue(query);
    fake.create.mockReturnValue({ collection: fake.collection, db: { terminate: fake.terminate } });
  }

  it('reads scoped calls for the date window, decodes timestamps, and filters roles', async () => {
    setup();
    const now = Date.now();
    const createdAt = Timestamp.fromMillis(now);
    fake.get.mockResolvedValue({
      docs: [
        { data: () => ({ id: 'draft', role: 'draft', createdAt }) },
        { data: () => ({ id: 'triage', role: 'triage', createdAt }) },
      ],
    });
    const rows = await readAuditRows({
      days: 7,
      role: 'draft',
      production: true,
      firestore: true,
      gcloudAuth: false,
    });
    expect(fake.create).toHaveBeenCalledWith({
      projectId: 'audit-project',
      databaseId: 'production',
      installationId: 'owner-workspace',
      authClient: undefined,
    });
    expect(fake.collection).toHaveBeenCalledWith('modelCallAudit');
    const [field, operator, since] = fake.where.mock.calls[0] ?? [];
    expect([field, operator]).toEqual(['createdAt', '>=']);
    expect(since.getTime()).toBeGreaterThanOrEqual(now - 7 * 86_400_000);
    expect(since.getTime()).toBeLessThanOrEqual(Date.now() - 7 * 86_400_000);
    expect(fake.orderBy).toHaveBeenCalledWith('createdAt', 'desc');
    expect(fake.select.mock.calls[0]).not.toContain('systemPrompt');
    expect(rows).toEqual([{ id: 'draft', role: 'draft', createdAt: new Date(now) }]);
    expect(fake.terminate).toHaveBeenCalledOnce();
  });

  it('closes the connection if the read fails', async () => {
    setup();
    fake.get.mockRejectedValue(new Error('permission denied'));
    await expect(
      readAuditRows({
        days: 7,
        production: true,
        firestore: true,
        gcloudAuth: false,
      }),
    ).rejects.toThrow('permission denied');
    expect(fake.terminate).toHaveBeenCalledOnce();
  });
});
