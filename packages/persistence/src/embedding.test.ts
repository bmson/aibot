import { describe, expect, it } from 'vitest';
import { embeddingModelId } from './embedding.js';

describe('embedding model identity', () => {
  it('keeps OpenRouter vendor-qualified IDs and prefixes direct providers', () => {
    const base = { dimensions: 1536, revision: '1' };
    expect(
      embeddingModelId({ ...base, provider: 'openrouter', model: 'openai/text-embedding-3-small' }),
    ).toBe('openai/text-embedding-3-small');
    expect(embeddingModelId({ ...base, provider: 'vertex', model: 'gemini-embedding-001' })).toBe(
      'vertex/gemini-embedding-001',
    );
  });
});
