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
const db = createDb(process.env.DATABASE_URL, { max: 1 });
const router = new ModelRouter(db, process.env.OPENROUTER_API_KEY);
const requested = process.argv.slice(2);
try {
  for (const model of modelDefaults.filter((m) => !('embedding' in m.capabilities))) {
    if (requested.length && !requested.includes(model.id)) continue;
    const options = {
      modelOverride: model.id,
      maxOutputTokens: 256,
      abortSignal: AbortSignal.timeout(60_000),
    };
    try {
      const structured = await router.object('classify', {
        ...options,
        temperature: 1,
        prompt: 'Return a JSON object with status equal to ok.',
        schema: z.object({ status: z.literal('ok') }),
      });
      if (!structured.ok || structured.modelId !== model.id || structured.object.status !== 'ok') {
        throw new Error('structured output failed or silently fell back');
      }
      const called = await router.step('reason', {
        ...options,
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
      console.log(`${model.id}: structured output + forced tool call passed`);
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
