import { modelMessageSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import { toolResultMessage } from './executor.js';

describe('toolResultMessage', () => {
  it('produces schema-valid messages from tool results holding Date instances', () => {
    // Regression: memory.recall returns drizzle rows with createdAt as a Date.
    // Raw Dates in the window failed the AI SDK's ModelMessage validation on
    // the NEXT step (AI_InvalidPromptError), while retries — rehydrating the
    // window from the jsonb checkpoint — passed, masking the bug as flakiness.
    const msg = toolResultMessage('call_1', 'memory.recall', {
      memories: [{ content: 'fact', createdAt: new Date('2026-07-17T06:57:27.773Z') }],
    });
    expect(modelMessageSchema.safeParse(msg).success).toBe(true);
  });

  it('drops undefined props instead of leaking them into the window', () => {
    const msg = toolResultMessage('call_2', 'contacts.lookup', {
      contact: { name: 'Ada', phone: undefined },
    });
    expect(modelMessageSchema.safeParse(msg).success).toBe(true);
    expect(JSON.stringify(msg)).not.toContain('undefined');
  });

  it('still truncates oversized results', () => {
    const msg = toolResultMessage('call_3', 'web.fetch', { body: 'x'.repeat(10_000) });
    const part = (msg.content as Array<{ output: { value: { truncated?: boolean } } }>)[0];
    expect(part?.output.value.truncated).toBe(true);
    expect(modelMessageSchema.safeParse(msg).success).toBe(true);
  });
});
