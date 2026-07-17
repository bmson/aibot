import type { Db } from '@assistant/db';
import type { LanguageModel } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  streamText: vi.fn(),
  releaseReservation: vi.fn(async () => {}),
  reserveCost: vi.fn(async () => ({ ok: true as const, reservationId: 'reservation-1' })),
}));

vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => ({ chat: vi.fn(), textEmbeddingModel: vi.fn() }),
}));

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: stubs.streamText,
}));

vi.mock('../cost.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cost.js')>()),
  reserveCost: stubs.reserveCost,
  releaseReservation: stubs.releaseReservation,
}));

import { ModelRouter } from './router.js';

function makeRouter() {
  const router = new ModelRouter({} as Db, 'test-key');
  vi.spyOn(router, 'route').mockResolvedValue({
    ok: true,
    model: {} as LanguageModel,
    modelId: 'test/model',
    degraded: false,
    decision: { mode: 'primary' },
    params: {},
    promptCostPerMTok: 1,
    completionCostPerMTok: 1,
  });
  const meter = vi.fn(async () => {});
  (
    router as unknown as {
      meterWithoutRepeatingProviderWork: typeof meter;
    }
  ).meterWithoutRepeatingProviderWork = meter;
  return { router, meter };
}

function fakeStreamResult() {
  return {
    text: Promise.resolve('answer'),
    toUIMessageStreamResponse: () => new Response(),
  };
}

describe('ModelRouter streaming finalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubs.reserveCost.mockResolvedValue({ ok: true, reservationId: 'reservation-1' });
    stubs.streamText.mockReturnValue(fakeStreamResult());
  });

  it('releases the reservation and reports asynchronous stream errors', async () => {
    const { router } = makeRouter();
    const onError = vi.fn(async () => {});
    const outcome = await router.stream('draft', { prompt: 'hello', onError });
    expect(outcome.ok).toBe(true);

    const options = stubs.streamText.mock.calls[0]?.[0] as {
      onError: (event: { error: unknown }) => Promise<void>;
    };
    const error = new Error('provider stream failed');
    await options.onError({ error });
    expect(stubs.releaseReservation).toHaveBeenCalledWith({} as Db, 'reservation-1');
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('waits for durable completion and propagates persistence failures', async () => {
    const { router, meter } = makeRouter();
    const failure = new Error('database unavailable');
    const onComplete = vi.fn(async () => {
      throw failure;
    });
    await router.stream('draft', { prompt: 'hello', onComplete });
    const options = stubs.streamText.mock.calls[0]?.[0] as {
      onFinish: (event: { text: string }) => Promise<void>;
    };

    await expect(options.onFinish({ text: 'answer' })).rejects.toBe(failure);
    expect(meter).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith('answer');
  });

  it('releases a reservation when stream setup throws synchronously', async () => {
    const { router } = makeRouter();
    stubs.streamText.mockImplementationOnce(() => {
      throw new Error('setup failed');
    });
    await expect(router.stream('draft', { prompt: 'hello' })).rejects.toThrow('setup failed');
    expect(stubs.releaseReservation).toHaveBeenCalledWith({} as Db, 'reservation-1');
  });
});
