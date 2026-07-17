import { describe, expect, it } from 'vitest';
import { evaluateCanaryHealth } from './canary.js';

const now = new Date('2026-07-17T12:00:00.000Z');

describe('evaluateCanaryHealth', () => {
  it('distinguishes healthy, failed, missing, running, and stale runs', () => {
    expect(evaluateCanaryHealth(null, { now }).state).toBe('missing');
    expect(
      evaluateCanaryHealth(
        {
          status: 'completed',
          ok: true,
          startedAt: '2026-07-17T10:00:00.000Z',
          finishedAt: '2026-07-17T10:01:00.000Z',
        },
        { now },
      ),
    ).toMatchObject({ ok: true, state: 'healthy' });
    expect(
      evaluateCanaryHealth(
        { status: 'completed', ok: false, startedAt: '2026-07-17T10:00:00.000Z' },
        { now },
      ).state,
    ).toBe('failed');
    expect(
      evaluateCanaryHealth(
        { status: 'running', ok: null, startedAt: '2026-07-17T11:55:00.000Z' },
        { now },
      ).state,
    ).toBe('running');
    expect(
      evaluateCanaryHealth(
        { status: 'running', ok: null, startedAt: '2026-07-17T11:00:00.000Z' },
        { now },
      ).state,
    ).toBe('stale');
    expect(
      evaluateCanaryHealth(
        {
          status: 'completed',
          ok: true,
          startedAt: '2026-07-15T10:00:00.000Z',
          finishedAt: '2026-07-15T10:01:00.000Z',
        },
        { now },
      ).state,
    ).toBe('stale');
  });
});
