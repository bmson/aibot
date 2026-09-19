import { ModelRouter } from '@assistant/core';
import { createDb, modelDefaults } from '@assistant/db';
import { z } from 'zod';

// Opt-in live checks with synthetic data only. Usage is metered in the local DB.
try {
  process.loadEnvFile('.env');
} catch {
  /* Environment can be supplied directly. */
}
if (!process.env.OPENROUTER_API_KEY || !process.env.DATABASE_URL) {
  throw new Error('OPENROUTER_API_KEY and local DATABASE_URL are required');
}
const chatModels = modelDefaults.filter((model) => !('embedding' in model.capabilities));
const requested = new Set(process.argv.slice(2));
const unknown = [...requested].filter(
  (modelId) => !chatModels.some((model) => model.id === modelId),
);
if (unknown.length > 0) {
  throw new Error(`Unknown model selection: ${unknown.join(', ')}`);
}
const db = createDb(process.env.DATABASE_URL, { max: 1 });
const router = new ModelRouter(db, process.env.OPENROUTER_API_KEY);
try {
  for (const model of chatModels) {
    if (requested.size > 0 && !requested.has(model.id)) continue;
    const options = () => ({
      modelOverride: model.id,
      maxOutputTokens: 256,
      abortSignal: AbortSignal.timeout(60_000),
    });
    try {
      const structured = await router.object('classify', {
        ...options(),
        temperature: 1,
        prompt: 'Return a JSON object with status equal to ok.',
        schema: z.object({ status: z.literal('ok') }),
      });
      if (!structured.ok || structured.modelId !== model.id || structured.object.status !== 'ok') {
        throw new Error('structured output failed or silently fell back');
      }
      const called = await router.step('reason', {
        ...options(),
        prompt: 'Call health.check with status ok. Do not answer with prose.',
        tools: {
          'health.check': {
            description: 'A synthetic health check.',
            inputSchema: z.object({ status: z.literal('ok') }),
          },
        },
        toolChoice: { type: 'tool', toolName: 'health.check' },
      });
      if (
        !called.ok ||
        called.modelId !== model.id ||
        called.toolCalls[0]?.toolName !== 'health.check' ||
        called.toolCalls[0]?.input.status !== 'ok'
      ) {
        throw new Error('forced tool call failed or silently fell back');
      }
      let streamText = '';
      let streamError: unknown;
      const streamed = await router.stream('draft', {
        ...options(),
        prompt: 'Reply with exactly OK and no other words.',
        onComplete: async (text) => {
          streamText = text;
        },
        onError: async (error) => {
          streamError = error;
        },
      });
      if (!streamed.ok || streamed.modelId !== model.id) {
        throw new Error('streamed draft failed or silently fell back');
      }
      for await (const _part of streamed.toUIMessageStream()) {
        // Fully consume the stream so provider errors and final callbacks run.
      }
      const resolvedText = (await streamed.text).trim();
      if (streamError) {
        throw new Error('streamed draft surfaced a provider error', { cause: streamError });
      }
      if (!streamText.trim() || !resolvedText || streamText.trim() !== resolvedText) {
        throw new Error('streamed draft returned empty or inconsistent text');
      }
      if (streamText.trim() !== 'OK') {
        throw new Error(`streamed draft returned unexpected text: ${streamText.trim()}`);
      }
      console.log(`${model.id}: structured output + forced tool call + streamed draft passed`);
    } catch (error) {
      // Only the error class is printed; provider errors may contain request metadata.
      console.error(
        `${model.id}: FAILED (${error instanceof Error ? error.name : 'unknown error'})`,
      );
      process.exitCode = 1;
    }
  }
} finally {
  await db.$client.end();
}
