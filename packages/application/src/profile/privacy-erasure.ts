import type { PrivacyErasureRepository } from '@assistant/persistence';

export interface PrivacyWorkspace {
  delete(relativePath: string): Promise<void>;
}

/** Complete the durable data phase, then acknowledge each successfully removed asset. */
export async function forgetLongTermMemoryWithRepository(
  repository: PrivacyErasureRepository,
  workspace?: PrivacyWorkspace,
) {
  const counts = await repository.erase();
  for (;;) {
    const assets = await repository.pendingAssets();
    if (!assets.length) break;
    if (!workspace) throw new Error('Workspace is required to finish memory erasure');
    for (const asset of assets) {
      await workspace.delete(asset.workspacePath);
      await repository.assetDeleted(asset.id);
    }
  }
  await repository.complete();
  return counts;
}
