export interface EmbeddingSpace {
  provider: string;
  model: string;
  dimensions: number;
  revision: string;
}

export function validateEmbedding(space: EmbeddingSpace, vector: number[]): void {
  if (
    !space.provider ||
    !space.model ||
    !space.revision ||
    !Number.isInteger(space.dimensions) ||
    space.dimensions < 1 ||
    space.dimensions > 2048 ||
    vector.length !== space.dimensions ||
    !vector.every(Number.isFinite) ||
    !vector.some((v) => v !== 0)
  ) {
    throw new Error('Invalid vector or incompatible embedding space');
  }
}
