import type { TaskRow } from '@assistant/db';
import { modelMessageSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import { shouldTaintContext, toolResultMessage } from './executor.js';

function task(
  trust: string,
  trigger: Record<string, unknown> | null,
): Pick<TaskRow, 'trust' | 'trigger'> {
  return { trust, trigger } as Pick<TaskRow, 'trust' | 'trigger'>;
}

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

describe('shouldTaintContext', () => {
  const emailFrom = (trust: string, quotesExternalContent?: unknown) =>
    task(trust, { source: 'email', payload: { quotesExternalContent } });

  it('taints any non-privileged sender regardless of channel', () => {
    expect(shouldTaintContext(task('known', { source: 'chat' }))).toBe(true);
    expect(shouldTaintContext(task('unknown', { source: 'chat' }))).toBe(true);
    // A known contact cannot un-taint themselves by writing a clean email.
    expect(shouldTaintContext(emailFrom('known', false))).toBe(true);
  });

  it('never taints owner chat or SMS', () => {
    expect(shouldTaintContext(task('owner', { source: 'chat' }))).toBe(false);
    expect(shouldTaintContext(task('owner', { source: 'sms' }))).toBe(false);
    expect(shouldTaintContext(task('assistant', { source: 'internal' }))).toBe(false);
  });

  it('taints owner email that quotes or forwards third-party content', () => {
    // The Fandango case: an owner-authenticated message wrapping a merchant's.
    expect(shouldTaintContext(emailFrom('owner', true))).toBe(true);
  });

  it('does not taint owner email that is entirely owner-authored', () => {
    expect(shouldTaintContext(emailFrom('owner', false))).toBe(false);
  });

  it('fails closed when the provenance flag is missing or not a boolean', () => {
    // Tasks enqueued before the flag existed, and anything that wrote a
    // non-boolean into the payload, keep the original taint-all-email behaviour.
    expect(shouldTaintContext(emailFrom('owner', undefined))).toBe(true);
    expect(shouldTaintContext(emailFrom('owner', 'false'))).toBe(true);
    expect(shouldTaintContext(emailFrom('owner', 0))).toBe(true);
    expect(shouldTaintContext(emailFrom('owner', null))).toBe(true);
    expect(shouldTaintContext(task('owner', { source: 'email' }))).toBe(true);
    expect(shouldTaintContext(task('owner', null))).toBe(false);
  });
});
