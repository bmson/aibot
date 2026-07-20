import { describe, expect, it } from 'vitest';
import { resolveOwnerPolicyValues } from './seed-values.js';

describe('resolveOwnerPolicyValues', () => {
  it('keeps durable contact values when the release job has no owner environment', () => {
    expect(
      resolveOwnerPolicyValues(
        {
          emails: ['owner@example.com', 'owner+calendar@example.com'],
          phones: ['+14155550123'],
        },
        { email: 'fallback@example.com', phone: '' },
      ),
    ).toEqual({
      emails: ['owner@example.com', 'owner+calendar@example.com'],
      phone: '+14155550123',
    });
  });

  it('uses configuration only when no durable contact value exists', () => {
    expect(
      resolveOwnerPolicyValues(undefined, {
        email: 'owner@example.com',
        phone: '+14155550123',
      }),
    ).toEqual({ emails: ['owner@example.com'], phone: '+14155550123' });
  });
});
