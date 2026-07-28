import { describe, expect, it, vi } from 'vitest';

/**
 * D7 regression pin: approval parks and owner pings fire exactly when
 * something needs the owner — they must carry the same budget carve-out
 * (critical: true) as final replies, or a day at the cap silently swallows
 * the one out-of-band signal the owner was supposed to get.
 */
const reserved: Array<{ source: string; critical?: boolean; description: string }> = [];

vi.mock('@assistant/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@assistant/core')>();
  return {
    ...actual,
    getRate: async () => ({ source: 'twilio_sms', unit: 'message', unitPriceUsd: 0.0079 }),
    reserveCost: async (
      _db: unknown,
      input: { source: string; critical?: boolean; description: string },
    ) => {
      reserved.push({
        source: input.source,
        critical: input.critical,
        description: input.description,
      });
      return { ok: true as const, reservationId: '00000000-0000-0000-0000-000000000000' };
    },
    reconcileReservation: async () => {},
    releaseReservation: async () => {},
  };
});

import { notifyApprovalsBySms, notifyOwnerBySms, type SmsChannelDeps } from './channel.js';

function fakeDeps(): SmsChannelDeps {
  // The channel rate-limit lookup runs before every send; an empty result
  // means "no limit configured", which keeps these tests about budgeting.
  const noRows = { from: () => ({ where: async () => [] }) };
  return {
    config: { OWNER_PHONE: '+14155550100' } as SmsChannelDeps['config'],
    db: { select: () => noRows } as unknown as SmsChannelDeps['db'],
    twilio: {
      configured: () => true,
      send: async () => ({ sid: 'SM-fake' }),
    } as unknown as SmsChannelDeps['twilio'],
  } as SmsChannelDeps;
}

describe('owner-facing SMS pings are budget-critical', () => {
  it('approval park notifications reserve with the critical carve-out', async () => {
    reserved.length = 0;
    await notifyApprovalsBySms(fakeDeps(), [
      { taskId: '00000000-0000-0000-0000-000000000001', shortCode: 'A9', summary: 'Send email' },
    ]);
    expect(reserved).toHaveLength(1);
    expect(reserved[0]?.critical).toBe(true);
  });

  it('owner async updates reserve with the critical carve-out', async () => {
    reserved.length = 0;
    await notifyOwnerBySms(fakeDeps(), { text: 'A task permanently failed.' });
    expect(reserved).toHaveLength(1);
    expect(reserved[0]?.critical).toBe(true);
  });
});
