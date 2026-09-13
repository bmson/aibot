import type { EmbeddingSpace } from './embedding.js';
import type { Records } from './records.js';

/** Learned-skill vectors share the application's configured 1536-dimension space. */
export const SKILL_EMBEDDING_DIMENSIONS = 1536;
export const DEFAULT_SKILL_RECALL_LIMIT = 4;
export const MAX_SKILL_RECALL_LIMIT = 100;
export const MIN_SKILL_RECALL_SIMILARITY = 0.72;

export type LearnedSkill = Omit<Records['skills'], 'embedding'>;

export interface SkillContextMatch {
  skill: LearnedSkill;
  similarity: number;
}

export interface SkillRecallInput {
  agentId: string;
  embedding: number[];
  limit?: number;
  minSimilarity?: number;
}

export interface SkillUseInput {
  agentId: string;
  ids: string[];
}

export interface SkillOutcomeInput {
  agentId: string;
  id: string;
  success: boolean;
}

/** Atomic learned-skill operations needed on the normal executor chat path. */
export interface SkillContextRepository {
  readonly kind: 'skill-context-repository';
  recall(input: SkillRecallInput): Promise<SkillContextMatch[]>;
  bumpUse(input: SkillUseInput): Promise<void>;
  recordOutcome(input: SkillOutcomeInput): Promise<void>;
}

export function skillRecallBounds(input: Pick<SkillRecallInput, 'limit' | 'minSimilarity'>): {
  limit: number;
  minSimilarity: number;
} {
  const limit = input.limit ?? DEFAULT_SKILL_RECALL_LIMIT;
  const minSimilarity = input.minSimilarity ?? MIN_SKILL_RECALL_SIMILARITY;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SKILL_RECALL_LIMIT)
    throw new Error('Invalid skill recall limit');
  if (!Number.isFinite(minSimilarity) || minSimilarity < -1 || minSimilarity > 1)
    throw new Error('Invalid skill similarity threshold');
  return { limit, minSimilarity };
}

export function validateSkillEmbedding(embedding: number[]): void {
  if (
    embedding.length !== SKILL_EMBEDDING_DIMENSIONS ||
    !embedding.every(Number.isFinite) ||
    !embedding.some((value) => value !== 0)
  )
    throw new Error('Invalid learned-skill embedding');
}

export function validateSkillEmbeddingSpace(space: EmbeddingSpace): void {
  if (
    !space.provider ||
    !space.model ||
    !space.revision ||
    space.dimensions !== SKILL_EMBEDDING_DIMENSIONS
  )
    throw new Error('Invalid learned-skill embedding space');
}
