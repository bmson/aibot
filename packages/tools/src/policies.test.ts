import { describe, expect, it } from 'vitest';
import { policyTemplates } from './policies.js';
import type { ToolContext } from './types.js';

const ctx = { trust: 'owner' } as ToolContext;

describe('policy templates', () => {
  it('sms.reply_to_owner: owner task and exact configured destination only', () => {
    const t = policyTemplates['sms.reply_to_owner'] as NonNullable<
      (typeof policyTemplates)[string]
    >;
    const owner = { phone: '+14155550100' };

    expect(t(owner, { to: '+14155550100' }, ctx)).toBe(true);
    expect(t(owner, { to: '+14155550199' }, ctx)).toBe(false);
    expect(t({}, { to: '+14155550100' }, ctx)).toBe(false);
    expect(t(owner, { to: '+14155550100' }, { ...ctx, trust: 'unknown' })).toBe(false);
  });

  it('calendar.self_only_events: no attendees only', () => {
    const t = policyTemplates['calendar.self_only_events'] as NonNullable<
      (typeof policyTemplates)[string]
    >;
    expect(t({}, { attendees: [] }, ctx)).toBe(true);
    expect(t({}, {}, ctx)).toBe(true);
    expect(t({}, { attendees: ['x@y.com'] }, ctx)).toBe(false);
  });

  it('calendar.owner_attendee_only: every attendee must be an owner address', () => {
    const t = policyTemplates['calendar.owner_attendee_only'] as NonNullable<
      (typeof policyTemplates)[string]
    >;
    const match = { emails: ['bmson@bmson.com'] };
    expect(t(match, { attendees: ['bmson@bmson.com'] }, ctx)).toBe(true);
    expect(t(match, { attendees: ['BMSON@bmson.com'] }, ctx)).toBe(true); // case-insensitive
    // anyone else in the list breaks the match — that invite reaches a third party
    expect(t(match, { attendees: ['bmson@bmson.com', 'other@x.com'] }, ctx)).toBe(false);
    expect(t(match, { attendees: ['other@x.com'] }, ctx)).toBe(false);
    // no attendees = self-only template's job, not this one
    expect(t(match, { attendees: [] }, ctx)).toBe(false);
    // unconfigured match fails closed
    expect(t({}, { attendees: ['bmson@bmson.com'] }, ctx)).toBe(false);
    expect(t({ emails: [] }, { attendees: ['bmson@bmson.com'] }, ctx)).toBe(false);
  });
});
