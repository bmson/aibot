export interface PrivacyErasureCounts {
  memories: number;
  graphRelations: number;
  writingSamples: number;
}

export interface PrivacyErasureAsset {
  id: string;
  workspacePath: string;
}

/** Erasure may span multiple durable transactions; retries resume the same fence. */
export interface PrivacyErasureRepository {
  readonly kind: 'privacy-erasure-repository';
  erase(): Promise<PrivacyErasureCounts>;
  pendingAssets(): Promise<PrivacyErasureAsset[]>;
  assetDeleted(id: string): Promise<void>;
  complete(): Promise<void>;
}
