import type { PrivacyErasureRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { forgetLongTermMemoryWithRepository } from './privacy-erasure.js';

describe('portable long-term memory erasure', () => {
  it('keeps workspace cleanup pending across an interruption', async () => {
    const assets = [{ id: 'source', workspacePath: 'import/voice.txt' }];
    const erase = vi.fn(async () => ({ memories: 1, graphRelations: 2, writingSamples: 3 }));
    const complete = vi.fn(async () => {});
    const assetDeleted = vi.fn(async (id: string) => {
      const index = assets.findIndex((asset) => asset.id === id);
      if (index >= 0) assets.splice(index, 1);
    });
    const repository: PrivacyErasureRepository = {
      kind: 'privacy-erasure-repository',
      erase,
      pendingAssets: async () => [...assets],
      assetDeleted,
      complete,
    };
    const workspace = {
      delete: vi
        .fn()
        .mockRejectedValueOnce(new Error('storage unavailable'))
        .mockResolvedValueOnce(undefined),
    };
    await expect(forgetLongTermMemoryWithRepository(repository, workspace)).rejects.toThrow(
      'storage unavailable',
    );
    expect(assets).toHaveLength(1);
    expect(assetDeleted).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    await expect(forgetLongTermMemoryWithRepository(repository, workspace)).resolves.toEqual({
      memories: 1,
      graphRelations: 2,
      writingSamples: 3,
    });
    expect(assets).toHaveLength(0);
    expect(assetDeleted).toHaveBeenCalledWith('source');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(erase).toHaveBeenCalledTimes(2);
  });

  it('refuses to report completion without a workspace for pending assets', async () => {
    const repository: PrivacyErasureRepository = {
      kind: 'privacy-erasure-repository',
      erase: async () => ({ memories: 0, graphRelations: 0, writingSamples: 0 }),
      pendingAssets: async () => [{ id: 'source', workspacePath: 'import/voice.txt' }],
      assetDeleted: async () => {},
      complete: vi.fn(async () => {}),
    };
    await expect(forgetLongTermMemoryWithRepository(repository)).rejects.toThrow(
      'Workspace is required',
    );
    expect(repository.complete).not.toHaveBeenCalled();
  });
});
