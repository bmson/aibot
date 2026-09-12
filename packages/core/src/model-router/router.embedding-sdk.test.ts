import type { Db } from '@assistant/db';
import type { EmbeddingModel } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelProvider } from './provider.js';
import { EMBEDDING_DIMENSIONS, ModelRouter } from './router.js';

const stubs = vi.hoisted(() => ({
  reconcileReservation: vi.fn(async () => {}),
  releaseReservation: vi.fn(async () => {}),
  reserveCost: vi.fn(async () => ({ ok: true as const, reservationId: 'reservation-1' })),
}));

vi.mock('../cost.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cost.js')>()),
  reconcileReservation: stubs.reconcileReservation,
  releaseReservation: stubs.releaseReservation,
  reserveCost: stubs.reserveCost,
}));

type EmbedResult = {
  embeddings: number[][];
  usage?: { tokens: number };
  providerMetadata?: Record<string, unknown>;
  warnings?: unknown[];
};

type FakeEmbeddingModel = {
  modelId: string;
  doEmbed: (this: FakeEmbeddingModel, options: { values: string[] }) => Promise<EmbedResult>;
};

type DoEmbed = FakeEmbeddingModel['doEmbed'];

function vector(): number[] {
  return new Array(EMBEDDING_DIMENSIONS).fill(0);
}

function database(): Db {
  let selectCount = 0;
  return {
    select: () => ({
      from: () => ({
        where: async () => {
          selectCount += 1;
          return selectCount === 1
            ? [{ role: 'embed', primaryModel: 'test/embedding' }]
            : [{ id: 'test/embedding', promptCostPerMTok: '1' }];
        },
      }),
    }),
    insert: () => ({
      values: () => ({ returning: async () => [{ id: 'call-1' }] }),
    }),
  } as unknown as Db;
}

function provider(model: EmbeddingModel): ModelProvider {
  return {
    kind: 'vertex',
    assertModelId: vi.fn(),
    chat: vi.fn(),
    textEmbeddingModel: vi.fn(() => model),
    optionsFor: vi.fn(() => undefined),
    embeddingOptions: vi.fn(() => undefined),
    cacheHint: vi.fn(() => undefined),
    normalizeUsage: vi.fn((event: unknown) => {
      const usage = (event as { usage?: { inputTokens?: number } } | undefined)?.usage;
      const metadata = (
        event as { providerMetadata?: { vertex?: { usage?: { costUsd?: number } } } } | undefined
      )?.providerMetadata;
      return {
        inputTokens: usage?.inputTokens,
        outputTokens: 0,
        costUsd: metadata?.vertex?.usage?.costUsd ?? 0.01,
      };
    }),
  };
}

function embeddingModel(
  doEmbed: DoEmbed,
  options: { maxEmbeddingsPerCall?: number; supportsParallelCalls?: boolean } = {},
): EmbeddingModel {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'test/embedding',
    maxEmbeddingsPerCall: options.maxEmbeddingsPerCall,
    supportsParallelCalls: options.supportsParallelCalls ?? false,
    doEmbed,
  } as EmbeddingModel;
}

function router(model: EmbeddingModel): ModelRouter {
  return new ModelRouter(database(), 'unused', 'off', provider(model));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('timed out waiting for embedding calls');
}

beforeEach(() => {
  vi.clearAllMocks();
  stubs.reserveCost.mockResolvedValue({ ok: true, reservationId: 'reservation-1' });
});

describe('ModelRouter embedding accounting around the AI SDK', () => {
  it('meters a provider response before SDK vector-count validation rejects it', async () => {
    const doEmbed = vi.fn<DoEmbed>(async function (this: FakeEmbeddingModel, options) {
      expect(this.modelId).toBe('test/embedding');
      expect(options.values).toEqual(['one']);
      return { embeddings: [], usage: { tokens: 7 }, warnings: [] };
    });

    await expect(router(embeddingModel(doEmbed)).embed(['one'])).rejects.toThrow(
      'Expected 1 embeddings, but received 0',
    );

    expect(stubs.releaseReservation).not.toHaveBeenCalled();
    expect(stubs.reconcileReservation).toHaveBeenCalledWith(
      expect.anything(),
      'reservation-1',
      expect.objectContaining({ quantity: 7, usd: 0.01 }),
    );
  });

  it('waits for an already-started chunk before deciding a failed batch was unpaid', async () => {
    const lateChunk = deferred<EmbedResult>();
    const doEmbed = vi.fn<DoEmbed>(async function (this: FakeEmbeddingModel, { values }) {
      expect(this.modelId).toBe('test/embedding');
      if (values[0] === 'reject') throw new Error('provider chunk failed');
      return lateChunk.promise;
    });
    const outcome = router(
      embeddingModel(doEmbed, { maxEmbeddingsPerCall: 1, supportsParallelCalls: true }),
    ).embed(['reject', 'late']);

    await waitFor(() => doEmbed.mock.calls.length === 2);
    await Promise.resolve();
    expect(stubs.releaseReservation).not.toHaveBeenCalled();

    lateChunk.resolve({
      embeddings: [vector()],
      usage: { tokens: 4 },
      providerMetadata: { vertex: { usage: { costUsd: 0.02 } } },
      warnings: [],
    });
    await expect(outcome).rejects.toThrow('provider chunk failed');
    expect(stubs.releaseReservation).not.toHaveBeenCalled();
    expect(stubs.reconcileReservation).toHaveBeenCalledWith(
      expect.anything(),
      'reservation-1',
      expect.objectContaining({ quantity: 4, usd: 0.02 }),
    );
  });

  it('sums authoritative cost and usage from every completed SDK chunk', async () => {
    const doEmbed = vi.fn<DoEmbed>(async function (this: FakeEmbeddingModel, { values }) {
      expect(this.modelId).toBe('test/embedding');
      const first = values[0] === 'first';
      return {
        embeddings: [vector()],
        usage: { tokens: first ? 3 : 5 },
        providerMetadata: { vertex: { usage: { costUsd: first ? 0.02 : 0.03 } } },
        warnings: [],
      };
    });

    await expect(
      router(
        embeddingModel(doEmbed, { maxEmbeddingsPerCall: 1, supportsParallelCalls: true }),
      ).embed(['first', 'second']),
    ).resolves.toHaveLength(2);

    expect(stubs.reconcileReservation).toHaveBeenCalledWith(
      expect.anything(),
      'reservation-1',
      expect.objectContaining({ quantity: 8, usd: 0.05 }),
    );
    expect(stubs.releaseReservation).not.toHaveBeenCalled();
  });

  it('releases the reservation when the first provider request is rejected', async () => {
    const doEmbed = vi.fn<DoEmbed>(async function (this: FakeEmbeddingModel) {
      expect(this.modelId).toBe('test/embedding');
      throw new Error('authentication rejected');
    });

    await expect(router(embeddingModel(doEmbed)).embed(['one'])).rejects.toThrow(
      'authentication rejected',
    );

    expect(stubs.reconcileReservation).not.toHaveBeenCalled();
    expect(stubs.releaseReservation).toHaveBeenCalledWith(expect.anything(), 'reservation-1');
  });
});
