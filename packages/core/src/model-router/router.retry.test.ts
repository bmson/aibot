import type { Db } from '@assistant/db';
import type { LanguageModel } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const stubs = vi.hoisted(() => ({
  generateText: vi.fn(),
  generateObject: vi.fn(),
  releaseReservation: vi.fn(async () => {}),
  reserveCost: vi.fn(async () => ({ ok: true as const, reservationId: 'reservation-1' })),
}));

vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => ({ chat: vi.fn(), textEmbeddingModel: vi.fn() }),
}));

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: stubs.generateText,
  generateObject: stubs.generateObject,
}));

vi.mock('../cost.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cost.js')>()),
  reserveCost: stubs.reserveCost,
  releaseReservation: stubs.releaseReservation,
}));

import { isProviderCapabilityError, ModelRouter } from './router.js';

/** The DOMException our per-call deadline (AbortSignal.timeout) aborts with. */
function deadlineTimeout() {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

function capabilityError(message: string) {
  const err = new Error(message);
  err.name = 'AI_APICallError';
  return err;
}

function makeRouter() {
  const router = new ModelRouter({} as Db, 'test-key');
  const primary = {
    ok: true,
    model: {} as LanguageModel,
    modelId: 'test/model',
    degraded: false,
    thinking: false,
    decision: { mode: 'primary' },
    params: {},
    promptCostPerMTok: 1,
    completionCostPerMTok: 1,
  } as const;
  const fallback = { ...primary, modelId: 'test/fallback', degraded: true };
  const route = vi
    .spyOn(router, 'route')
    .mockImplementation(async (_role, options) => (options?.forceFallback ? fallback : primary));
  const meter = vi.fn(async () => {});
  (
    router as unknown as { meterWithoutRepeatingProviderWork: typeof meter }
  ).meterWithoutRepeatingProviderWork = meter;
  return { router, route };
}

function stepResult() {
  return {
    text: '',
    toolCalls: [],
    finishReason: 'tool-calls',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

describe('isProviderCapabilityError', () => {
  it('detects provider request-shape rejections by name + message', () => {
    expect(
      isProviderCapabilityError(
        capabilityError('response format json_schema is not supported trace_id: abc'),
      ),
    ).toBe(true);
    expect(
      isProviderCapabilityError(capabilityError('No endpoints found matching your parameters')),
    ).toBe(true);
    expect(isProviderCapabilityError(capabilityError('No allowed providers are available'))).toBe(
      true,
    );
    expect(isProviderCapabilityError(capabilityError('A payment method is required'))).toBe(true);
    const paymentStatus = capabilityError('Request denied');
    Object.assign(paymentStatus, { statusCode: 402 });
    expect(isProviderCapabilityError(paymentStatus)).toBe(true);
    const retryError = new Error('provider retry attempts failed');
    retryError.name = 'AI_RetryError';
    Object.assign(retryError, { lastError: capabilityError('A payment method is required') });
    expect(isProviderCapabilityError(retryError)).toBe(true);
  });

  it('leaves transient and unrelated errors to the task-level retry', () => {
    expect(isProviderCapabilityError(capabilityError('Rate limit exceeded'))).toBe(false);
    expect(isProviderCapabilityError(capabilityError('Internal server error'))).toBe(false);
    expect(isProviderCapabilityError(new Error('response format json_schema is not supported'))) //
      .toBe(false); // right message, wrong error class
    expect(isProviderCapabilityError(deadlineTimeout())).toBe(false);
    expect(isProviderCapabilityError(null)).toBe(false);
  });
});

describe('ModelRouter timeout retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubs.reserveCost.mockResolvedValue({ ok: true, reservationId: 'reservation-1' });
  });

  it('reserves reasoning headroom when a reasoning model must call a tool', async () => {
    const { router, route } = makeRouter();
    const configured = await route.getMockImplementation()?.('reason', {});
    if (!configured?.ok) throw new Error('missing mock route');
    route.mockResolvedValue({ ...configured, thinking: true });
    stubs.generateText.mockResolvedValue(stepResult());
    await router.step('reason', {
      prompt: 'Call the tool.',
      tools: {},
      toolChoice: 'required',
      maxOutputTokens: 256,
    });
    expect(stubs.generateText.mock.calls[0]?.[0]).toMatchObject({
      maxOutputTokens: 4352,
      providerOptions: { openrouter: { reasoning: { max_tokens: 4096 } } },
    });
  });

  it('step() retries once when the per-call deadline fires, with a fresh reservation', async () => {
    const { router } = makeRouter();
    stubs.generateText.mockRejectedValueOnce(deadlineTimeout()).mockResolvedValueOnce(stepResult());

    const outcome = await router.step('reason', { prompt: 'go', tools: {} });

    expect(outcome.ok).toBe(true);
    expect(stubs.generateText).toHaveBeenCalledTimes(2);
    // The timed-out try must not hold budget: its reservation was released
    // and the retry made its own.
    expect(stubs.releaseReservation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'cost-repository' }),
      'reservation-1',
    );
    expect(stubs.reserveCost).toHaveBeenCalledTimes(2);
  });

  it('step() gives up after a second timeout so the task-level retry takes over', async () => {
    const { router } = makeRouter();
    stubs.generateText.mockRejectedValue(deadlineTimeout());

    await expect(router.step('reason', { prompt: 'go', tools: {} })).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(stubs.generateText).toHaveBeenCalledTimes(2);
  });

  it('step() uses one configured fallback for a wrapped payment-required error', async () => {
    const { router, route } = makeRouter();
    const retryError = new Error('provider retry attempts failed');
    retryError.name = 'AI_RetryError';
    Object.assign(retryError, { lastError: capabilityError('A payment method is required') });
    stubs.generateText
      .mockRejectedValueOnce(retryError)
      .mockResolvedValueOnce({ ...stepResult(), text: 'Fallback answer.', finishReason: 'stop' });

    const outcome = await router.step('reason', { prompt: 'go', tools: {} });

    expect(outcome.ok && outcome.modelId).toBe('test/fallback');
    expect(stubs.generateText).toHaveBeenCalledTimes(2);
    expect(route.mock.calls.some((call) => call[1]?.forceFallback)).toBe(true);
  });

  it('step() preserves the original payment error when its distinct fallback fails', async () => {
    const { router } = makeRouter();
    const paymentError = capabilityError('A payment method is required');
    stubs.generateText
      .mockRejectedValueOnce(paymentError)
      .mockRejectedValueOnce(new Error('fallback unavailable'));

    await expect(router.step('reason', { prompt: 'go', tools: {} })).rejects.toBe(paymentError);
    expect(stubs.generateText).toHaveBeenCalledTimes(2);
  });

  it('step() does not retry a payment error when fallback resolves to the same model', async () => {
    const { router, route } = makeRouter();
    const primary = await route.getMockImplementation()?.('reason', {});
    if (!primary?.ok) throw new Error('missing mock route');
    route.mockResolvedValue(primary);
    const paymentError = capabilityError('A payment method is required');
    stubs.generateText.mockRejectedValue(paymentError);

    await expect(router.step('reason', { prompt: 'go', tools: {} })).rejects.toBe(paymentError);
    expect(stubs.generateText).toHaveBeenCalledOnce();
  });

  it('step() does not retry non-timeout errors', async () => {
    const { router } = makeRouter();
    stubs.generateText.mockRejectedValue(capabilityError('Rate limit exceeded'));

    await expect(router.step('reason', { prompt: 'go', tools: {} })).rejects.toThrow('Rate limit');
    expect(stubs.generateText).toHaveBeenCalledTimes(1);
  });

  it('step() retries an obvious repeated fragment once on a distinct role fallback', async () => {
    const { router, route } = makeRouter();
    const primary = await route.getMockImplementation()?.('reason', {});
    if (!primary?.ok) throw new Error('missing mock route');
    const fallback = { ...primary, modelId: 'test/fallback', degraded: true };
    route
      .mockResolvedValueOnce(primary)
      .mockResolvedValueOnce(fallback)
      .mockResolvedValueOnce(fallback);
    stubs.generateText
      .mockResolvedValueOnce({ ...stepResult(), text: ']">'.repeat(1_200) })
      .mockResolvedValueOnce({
        ...stepResult(),
        text: 'The answer is ready.',
        finishReason: 'stop',
      });

    const outcome = await router.step('reason', { prompt: 'go', tools: {} });

    expect(outcome).toMatchObject({ text: 'The answer is ready.', modelId: 'test/fallback' });
    expect(stubs.generateText).toHaveBeenCalledTimes(2);
    expect(route.mock.calls.map((call) => call[1]?.forceFallback)).toEqual([false, true, true]);
  });

  it('does not run the repetition guard when the owner explicitly requested repetition', async () => {
    const { router } = makeRouter();
    const repeated = 'bad-token-'.repeat(30);
    stubs.generateText.mockResolvedValue({ ...stepResult(), text: repeated, finishReason: 'stop' });

    const outcome = await router.step('reason', {
      prompt: 'Repeat this exactly: bad-token-',
      tools: {},
    });

    expect(outcome.ok && outcome.text).toBe(repeated);
    expect(stubs.generateText).toHaveBeenCalledOnce();
  });

  it("step() does not retry when the caller's own signal already aborted", async () => {
    const { router } = makeRouter();
    const controller = new AbortController();
    controller.abort(deadlineTimeout());
    stubs.generateText.mockRejectedValue(deadlineTimeout());

    await expect(
      router.step('reason', { prompt: 'go', tools: {}, abortSignal: controller.signal }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(stubs.generateText).toHaveBeenCalledTimes(1);
  });

  it('generate() retries once on timeout', async () => {
    const { router } = makeRouter();
    stubs.generateText
      .mockRejectedValueOnce(deadlineTimeout())
      .mockResolvedValueOnce({ text: 'ok', finishReason: 'stop', usage: {} });

    const outcome = await router.generate('draft', { prompt: 'hello' });
    expect(outcome.ok && outcome.text).toBe('ok');
    expect(stubs.generateText).toHaveBeenCalledTimes(2);
  });
});

describe('ModelRouter.object provider-capability fallback', () => {
  const schema = z.object({ answer: z.string() });

  beforeEach(() => {
    vi.clearAllMocks();
    stubs.reserveCost.mockResolvedValue({ ok: true, reservationId: 'reservation-1' });
  });

  it('retries on the fallback model when a provider rejects json_schema', async () => {
    const { router, route } = makeRouter();
    stubs.generateObject
      .mockRejectedValueOnce(capabilityError('response format json_schema is not supported'))
      .mockResolvedValueOnce({ object: { answer: 'ok' } });

    const outcome = await router.object('extract', { prompt: 'go', schema });

    expect(outcome.ok && outcome.object).toEqual({ answer: 'ok' });
    expect(stubs.generateObject).toHaveBeenCalledTimes(2);
    // Second routing decision must ask for the role's fallback model.
    expect(route.mock.calls[0]?.[1]?.forceFallback).toBeFalsy();
    expect(route.mock.calls[2]?.[1]?.forceFallback).toBe(true);
  });

  it('object() still surfaces transient errors without a model switch', async () => {
    const { router } = makeRouter();
    stubs.generateObject.mockRejectedValue(capabilityError('Rate limit exceeded'));

    await expect(router.object('extract', { prompt: 'go', schema })).rejects.toThrow('Rate limit');
    expect(stubs.generateObject).toHaveBeenCalledTimes(1);
  });

  it('object() does not retry a provider error when the role fallback is the same model', async () => {
    const { router, route } = makeRouter();
    const primary = await route.getMockImplementation()?.('extract', {});
    if (!primary?.ok) throw new Error('missing mock route');
    route.mockResolvedValue(primary);
    const paymentError = capabilityError('A payment method is required');
    stubs.generateObject.mockRejectedValue(paymentError);

    await expect(router.object('extract', { prompt: 'go', schema })).rejects.toBe(paymentError);
    expect(stubs.generateObject).toHaveBeenCalledOnce();
  });

  it('object() combines timeout retry with the capability fallback', async () => {
    const { router, route } = makeRouter();
    // Primary: timeout, then capability rejection. Fallback: success.
    stubs.generateObject
      .mockRejectedValueOnce(deadlineTimeout())
      .mockRejectedValueOnce(capabilityError('response format json_schema is not supported'))
      .mockResolvedValueOnce({ object: { answer: 'ok' } });

    const outcome = await router.object('extract', { prompt: 'go', schema });

    expect(outcome.ok && outcome.object).toEqual({ answer: 'ok' });
    expect(stubs.generateObject).toHaveBeenCalledTimes(3);
    expect(route.mock.calls[4]?.[1]?.forceFallback).toBe(true);
  });
});
