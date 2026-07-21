import type { TaskRow } from '@assistant/db';
import { modelMessageSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import type { Plan } from '../events.js';
import {
  replaceToolResultMessage,
  roleForTask,
  shouldTaintContext,
  toolResultMessage,
} from './executor.js';

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

  it('replaces provisional and duplicate results when a call settles', () => {
    const window = [
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'tool-call' as const,
            toolCallId: 'call_browser',
            toolName: 'browser.execute',
            input: {},
          },
        ],
      },
      toolResultMessage('call_browser', 'browser.execute', {
        status: 'awaiting_owner_approval',
      }),
      toolResultMessage('call_browser', 'browser.execute', {
        status: 'background_job_running',
      }),
    ];

    replaceToolResultMessage(window, 'call_browser', 'browser.execute', {
      ok: true,
      outputs: ['job listing'],
    });

    const results = window.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter(
            (part) => part.type === 'tool-result' && part.toolCallId === 'call_browser',
          )
        : [],
    );
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0])).toContain('job listing');
    expect(JSON.stringify(window)).not.toContain('awaiting_owner_approval');
    expect(JSON.stringify(window)).not.toContain('background_job_running');
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

  it('taints a task scheduled from a tainted session regardless of source (S1)', () => {
    // task.schedule stamps taintedOrigin; without honoring it, a laundered
    // instruction would run in a clean context with autonomous network egress.
    expect(
      shouldTaintContext(
        task('assistant', { source: 'internal', payload: { taintedOrigin: true } }),
      ),
    ).toBe(true);
    expect(
      shouldTaintContext(task('owner', { source: 'internal', payload: { taintedOrigin: true } })),
    ).toBe(true);
    // A clean scheduled child (no taint marker) stays autonomous.
    expect(
      shouldTaintContext(task('assistant', { source: 'internal', payload: { instruction: 'ok' } })),
    ).toBe(false);
  });
});

describe('roleForTask', () => {
  const t = (type: string, goalId: string | null = null) =>
    ({ type, goalId }) as Pick<TaskRow, 'type' | 'goalId'>;
  const plan = (action: Plan['action']): Plan =>
    ({ action, reasoning: '', steps: [], missingInfo: [] }) as Plan;

  it('routes inherently action-oriented types to reason', () => {
    expect(roleForTask(t('mission'), null)).toBe('reason');
    expect(roleForTask(t('email_triage'), plan('reply'))).toBe('reason'); // always
    expect(roleForTask(t('adhoc'), null)).toBe('reason');
    // An unattended goal session (scheduled with a goalId) is always reason.
    expect(roleForTask(t('scheduled', 'goal-1'), null)).toBe('reason');
  });

  it('routes a planned action on chat/sms/scheduled to reason, plain reply to draft', () => {
    expect(roleForTask(t('chat_turn'), plan('workflow'))).toBe('reason');
    expect(roleForTask(t('sms_turn'), plan('schedule'))).toBe('reason');
    expect(roleForTask(t('scheduled'), plan('mission'))).toBe('reason');
    // A direct-answer plan, or the trivial short-circuit (null plan), stays cheap.
    expect(roleForTask(t('chat_turn'), plan('reply'))).toBe('draft');
    expect(roleForTask(t('chat_turn'), null)).toBe('draft');
    expect(roleForTask(t('sms_turn'), null)).toBe('draft');
  });
});
