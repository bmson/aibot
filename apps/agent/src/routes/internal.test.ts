import { describe, expect, it } from 'vitest';
import { failedCanaryChecks } from './internal.js';

/**
 * The hourly canary alert used to carry only a verdict — "The latest canary run
 * failed." — so every red hour started with a database query to learn which of
 * the five checks broke. These pin what the log line now says instead.
 */
describe('failedCanaryChecks', () => {
  it('names each failing check and quotes its reason', () => {
    expect(
      failedCanaryChecks({
        checks: {
          gmail: { ok: true, detail: 'round-tripped in 4.1s' },
          chat: { ok: false, detail: 'model routing blocked: daily budget exhausted' },
          browser: { ok: false, detail: 'daily budget cannot cover this' },
        },
      }),
    ).toEqual({
      failed: ['chat', 'browser'],
      reasons: {
        chat: 'model routing blocked: daily budget exhausted',
        browser: 'daily budget cannot cover this',
      },
    });
  });

  it('does not count a skipped check as a failure', () => {
    // Twilio unconfigured is a legitimate skip, not something to alert on.
    expect(
      failedCanaryChecks({
        checks: { sms: { ok: false, skipped: true, detail: 'twilio is not configured' } },
      }),
    ).toEqual({ failed: [], reasons: {} });
  });

  it('clips a long reason so one check cannot flood the log line', () => {
    const { reasons } = failedCanaryChecks({
      checks: { chat: { ok: false, detail: 'x'.repeat(900) } },
    });
    expect(reasons.chat).toHaveLength(500);
  });

  it('reports a failing check that carries no detail at all', () => {
    expect(failedCanaryChecks({ checks: { approval: { ok: false } } })).toEqual({
      failed: ['approval'],
      reasons: {},
    });
  });

  it('survives a missing or malformed row rather than throwing on the alert path', () => {
    expect(failedCanaryChecks(null)).toEqual({ failed: [], reasons: {} });
    expect(failedCanaryChecks({})).toEqual({ failed: [], reasons: {} });
    expect(failedCanaryChecks({ checks: { gmail: null as unknown as object } })).toEqual({
      failed: [],
      reasons: {},
    });
  });
});
