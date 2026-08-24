import { describe, expect, it, vi } from 'vitest';
import { recallWithGraphFallback } from './graph-recall.js';

const graphResult = {
  block: 'Graph evidence',
  used: 1,
  candidates: 1,
  sources: [
    { date: '2026-08-24', label: 'Graph fact', kind: 'knowledge_graph' as const, hops: 1 as const },
  ],
};

describe('recallWithGraphFallback', () => {
  it('shares a successful graph embedding with standard recall and preserves both provenances', async () => {
    const history = vi.fn(async (embedding: number[] | undefined) => {
      expect(embedding).toEqual([0.1, 0.2]);
      return {
        block: 'Earlier discussion',
        sources: [{ date: '2026-08-23', label: 'Chat fact', kind: 'chat' as const }],
      };
    });

    const result = await recallWithGraphFallback({
      graph: async () => ({ graph: graphResult, queryEmbedding: [0.1, 0.2] }),
      history,
    });

    expect(history).toHaveBeenCalledOnce();
    expect(result.block).toBe('Graph evidence\n\nEarlier discussion');
    expect(result.sources).toEqual([
      ...graphResult.sources,
      { date: '2026-08-23', label: 'Chat fact', kind: 'chat' },
    ]);
  });

  it('continues with standard recall when GraphRAG or its embedding fails', async () => {
    const outage = new Error('graph database unavailable');
    const onGraphError = vi.fn();
    const history = vi.fn(async (embedding: number[] | undefined) => {
      expect(embedding).toBeUndefined();
      return {
        block: 'Earlier discussion remains available',
        sources: [{ date: '2026-08-23', label: 'Chat fact' }],
      };
    });

    const result = await recallWithGraphFallback({
      graph: async () => {
        throw outage;
      },
      history,
      onGraphError,
    });

    expect(onGraphError).toHaveBeenCalledWith(outage);
    expect(history).toHaveBeenCalledOnce();
    expect(result.block).toBe('Earlier discussion remains available');
    expect(result.graph.used).toBe(0);
  });

  it('does not invoke the graph layer when it is disabled', async () => {
    const history = vi.fn(async () => ({ block: '', sources: [] }));

    const result = await recallWithGraphFallback({ history });

    expect(history).toHaveBeenCalledWith(undefined, expect.objectContaining({ used: 0 }));
    expect(result).toMatchObject({ block: '', sources: [], graph: { used: 0 } });
  });
});
