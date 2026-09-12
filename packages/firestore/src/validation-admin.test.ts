import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  create: vi.fn(),
  index: vi.fn(),
  remove: vi.fn(),
  close: vi.fn(),
  terminate: vi.fn(),
}));
vi.mock('@google-cloud/firestore', () => ({
  default: {
    v1: {
      FirestoreAdminClient: class {
        createDatabase = calls.create;
        createIndex = calls.index;
        deleteDatabase = calls.remove;
        close = calls.close;
      },
    },
  },
}));
vi.mock('./store.js', () => ({
  createInstallationStore: () => ({ db: { terminate: calls.terminate } }),
}));
vi.mock('./task-lifecycle.js', () => ({ dueTasksQuery: vi.fn() }));

import { withValidationDatabase } from './validation-admin.js';

describe('isolated live-validation resource lifecycle', () => {
  beforeEach(() => {
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '');
    const operation = () => [{ promise: async () => [] }];
    calls.create.mockReset().mockImplementation(operation);
    calls.index.mockReset().mockImplementation(operation);
    calls.remove.mockReset().mockImplementation(operation);
    calls.close.mockReset().mockResolvedValue(undefined);
    calls.terminate.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllEnvs());
  const input = {
    projectId: 'test-project',
    location: 'us-west1',
    indexes: [],
    progress: () => {},
  };
  it('deletes only the fresh generated database when validation fails', async () => {
    await expect(
      withValidationDatabase(input, async () => {
        throw new Error('validation failed');
      }),
    ).rejects.toThrow('validation failed');
    const create = calls.create.mock.calls[0]?.[0];
    expect(create.databaseId).toMatch(/^assistant-validation-[a-f0-9]{16}$/);
    expect(calls.remove).toHaveBeenCalledWith({
      name: `projects/test-project/databases/${create.databaseId}`,
    });
    expect(calls.close).toHaveBeenCalledOnce();
  });
  it('does not adopt or delete a database after rejected creation', async () => {
    calls.create.mockRejectedValue(new Error('already exists'));
    await expect(withValidationDatabase(input, async () => true)).rejects.toThrow('already exists');
    expect(calls.remove).not.toHaveBeenCalled();
    expect(calls.close).toHaveBeenCalledOnce();
  });
  it('still removes the database if client termination fails', async () => {
    calls.terminate.mockRejectedValue(new Error('close failed'));
    await expect(withValidationDatabase(input, async () => true)).rejects.toThrow('close failed');
    expect(calls.remove).toHaveBeenCalledOnce();
    expect(calls.close).toHaveBeenCalledOnce();
  });
  it('refuses emulator routing before creating any cloud resources', async () => {
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8789');
    await expect(withValidationDatabase(input, async () => true)).rejects.toThrow(
      'refuses emulator',
    );
    expect(calls.create).not.toHaveBeenCalled();
  });
  it('starts independent indexes together and waits for all builds before cleanup after a failure', async () => {
    let finishSecond!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    calls.index
      .mockImplementationOnce(() => [
        {
          promise: async () => {
            throw new Error('index failed');
          },
        },
      ])
      .mockImplementationOnce(() => [{ promise: () => pending }]);
    const validate = vi.fn();
    const progress = vi.fn();
    const run = withValidationDatabase(
      {
        ...input,
        progress,
        indexes: [{ collectionGroup: 'tasks' }, { collectionGroup: 'outbox' }],
      },
      validate,
    );
    const rejection = expect(run).rejects.toThrow('index failed');
    await vi.waitFor(() => expect(calls.index).toHaveBeenCalledTimes(2));
    expect(calls.remove).not.toHaveBeenCalled();
    finishSecond();
    await rejection;
    expect(validate).not.toHaveBeenCalled();
    expect(calls.remove).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith(
      'validation_failed',
      expect.objectContaining({ message: 'index failed' }),
    );
    expect(progress.mock.calls.findIndex(([stage]) => stage === 'validation_failed')).toBeLessThan(
      progress.mock.calls.findIndex(([stage]) => stage === 'deleting_database'),
    );
  });
  it('reports a passed workload before waiting for database cleanup', async () => {
    const progress = vi.fn();
    await expect(
      withValidationDatabase({ ...input, progress }, async () => 'passed'),
    ).resolves.toBe('passed');
    expect(progress.mock.calls.findIndex(([stage]) => stage === 'validation_passed')).toBeLessThan(
      progress.mock.calls.findIndex(([stage]) => stage === 'deleting_database'),
    );
  });
});

it('keeps deployable composite indexes and field overrides in their correct sections', async () => {
  const spec = JSON.parse(
    await readFile(
      new URL('../../../infra/gcp/firestore/firestore.indexes.json', import.meta.url),
      'utf8',
    ),
  );
  for (const index of spec.indexes) {
    expect(index).toMatchObject({
      collectionGroup: expect.any(String),
      queryScope: expect.any(String),
      fields: expect.any(Array),
    });
    expect(index.fields.length).toBeGreaterThan(1);
    expect(index).not.toHaveProperty('fieldPath');
  }
  for (const override of spec.fieldOverrides) {
    expect(override).toMatchObject({
      collectionGroup: expect.any(String),
      fieldPath: expect.any(String),
      indexes: expect.any(Array),
    });
    expect(override).not.toHaveProperty('fields');
  }
});
