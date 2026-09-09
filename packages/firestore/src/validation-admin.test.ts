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
});
