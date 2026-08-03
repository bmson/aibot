import type { Db } from '@assistant/db';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * Prompt-shape regression tests. Every router call that carries a transcript
 * moves the system prompt INTO `messages` (a system-role message is the only
 * shape that can carry the OpenRouter cache_control providerOption), and AI
 * SDK v7 rejects exactly that with AI_InvalidPromptError unless the call opts
 * in via `allowSystemInMessages`. The retry/stream suites stub the SDK entry
 * points, so this validation never ran in tests — in production it failed
 * every executor step ("System messages are not allowed in the prompt or
 * messages fields"). These tests run the REAL generateText/streamText/
 * generateObject against a mock model so the SDK's prompt validation is part
 * of the suite.
 */

const stubs = vi.hoisted(() => ({
  releaseReservation: vi.fn(async () => {}),
  reserveCost: vi.fn(async () => ({ ok: true as const, reservationId: 'reservation-1' })),
}));

vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => ({ chat: vi.fn(), textEmbeddingModel: vi.fn() }),
}));

vi.mock('../cost.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cost.js')>()),
  reserveCost: stubs.reserveCost,
  releaseReservation: stubs.releaseReservation,
}));

import { ModelRouter } from './router.js';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** Shapes are checked structurally against ai/test's own provider types. */
function generateResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage,
    warnings: [],
  };
}

function streamResult(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start' as const, warnings: [] },
        { type: 'text-start' as const, id: '1' },
        { type: 'text-delta' as const, id: '1', delta: text },
        { type: 'text-end' as const, id: '1' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage,
        },
      ],
    }),
  };
}

function makeRouter(model: MockLanguageModelV3) {
  const router = new ModelRouter({} as Db, 'test-key');
  vi.spyOn(router, 'route').mockResolvedValue({
    ok: true,
    model: model as unknown as LanguageModel,
    modelId: 'test/model',
    degraded: false,
    thinking: false,
    decision: { mode: 'primary' },
    params: {},
    promptCostPerMTok: 1,
    completionCostPerMTok: 1,
  });
  const meter = vi.fn(async () => {});
  (
    router as unknown as { meterWithoutRepeatingProviderWork: typeof meter }
  ).meterWithoutRepeatingProviderWork = meter;
  return router;
}

/** The exact call shape the executor step loop uses: system + transcript. */
const conversation = {
  system: 'You are the assistant.',
  messages: [
    { role: 'user' as const, content: 'hello' },
    { role: 'assistant' as const, content: 'hi' },
    { role: 'user' as const, content: 'proceed' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  stubs.reserveCost.mockResolvedValue({ ok: true, reservationId: 'reservation-1' });
});

describe('system prompt inside messages passes SDK prompt validation', () => {
  it('step(): the executor loop shape reaches the model with its system prefix', async () => {
    const model = new MockLanguageModelV3({ doGenerate: generateResult('ok') });
    const router = makeRouter(model);

    const outcome = await router.step('reason', {
      ...conversation,
      tools: {},
      maxOutputTokens: 512,
    });

    expect(outcome.ok).toBe(true);
    // The cache-hinted system message must actually arrive as the leading
    // system entry — that placement is the whole point of the opt-in.
    const prompt = model.doGenerateCalls[0]?.prompt;
    expect(prompt?.[0]?.role).toBe('system');
    expect(prompt).toHaveLength(conversation.messages.length + 1);
  });

  it('generate(): messages + system does not trip AI_InvalidPromptError', async () => {
    const model = new MockLanguageModelV3({ doGenerate: generateResult('ok') });
    const router = makeRouter(model);

    const outcome = await router.generate('draft', conversation);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.text).toBe('ok');
  });

  it('stream(): the chat path streams with its system prefix in messages', async () => {
    const model = new MockLanguageModelV3({ doStream: streamResult('streamed') });
    const router = makeRouter(model);

    const outcome = await router.stream('draft', conversation);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) await expect(outcome.text).resolves.toBe('streamed');
    expect(model.doStreamCalls[0]?.prompt?.[0]?.role).toBe('system');
  });

  it('object(): structured output accepts the same conversation shape', async () => {
    const model = new MockLanguageModelV3({ doGenerate: generateResult('{"answer":"ok"}') });
    const router = makeRouter(model);

    const outcome = await router.object('plan', {
      ...conversation,
      schema: z.object({ answer: z.string() }),
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.object).toEqual({ answer: 'ok' });
  });
});
