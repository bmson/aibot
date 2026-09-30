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

describe('owner-approved scoped actions', () => {
  it('texts match only the approved phone and owner trust', () => {
    const t = policyTemplates['sms.send.to_recipient'] as NonNullable<
      (typeof policyTemplates)[string]
    >;
    expect(t({ phone: '+14155550199' }, { to: '+14155550199' }, ctx)).toBe(true);
    expect(t({ phone: '+14155550199' }, { to: '+14155550200' }, ctx)).toBe(false);
    expect(t({ phone: '+14155550199' }, { to: '+14155550199' }, { ...ctx, trust: 'unknown' })).toBe(
      false,
    );
  });
  it('invitations match an exact normalized guest set, never a subset or added guest', () => {
    const t = policyTemplates['calendar.create_event.same_attendees'] as NonNullable<
      (typeof policyTemplates)[string]
    >;
    const match = { attendees: ['a@example.com', 'b@example.com'] };
    expect(t(match, { attendees: ['B@example.com', 'a@example.com'] }, ctx)).toBe(true);
    expect(t(match, { attendees: ['a@example.com'] }, ctx)).toBe(false);
    expect(t(match, { attendees: ['a@example.com', 'b@example.com', 'c@example.com'] }, ctx)).toBe(
      false,
    );
    expect(t({}, { attendees: [] }, ctx)).toBe(false);
    expect(t(match, { attendees: ['a@example.com', null] }, ctx)).toBe(false);
  });
  it('event edits stay on one event and never add guests', () => {
    const t = policyTemplates['calendar.update_event.same_event'] as NonNullable<
      (typeof policyTemplates)[string]
    >;
    const match = { eventId: 'event-123' };
    expect(t(match, { eventId: 'event-123', start: 'later' }, ctx)).toBe(true);
    expect(t(match, { eventId: 'event-456' }, ctx)).toBe(false);
    expect(t(match, { eventId: 'event-123', addAttendees: ['c@example.com'] }, ctx)).toBe(false);
    expect(t(match, { eventId: 'event-123', addAttendees: null }, ctx)).toBe(false);
  });
  it('email permission excludes attachments, other recipients and non-owner tasks', () => {
    const t = policyTemplates['gmail.send.to_recipient'] as NonNullable<
      (typeof policyTemplates)[string]
    >;
    const match = { recipient: 'a@example.com' };
    expect(t(match, { to: ['a@example.com'] }, ctx)).toBe(true);
    expect(
      t(match, { to: ['a@example.com'], attachments: [{ workspacePath: 'private.pdf' }] }, ctx),
    ).toBe(false);
    expect(t(match, { to: ['a@example.com', 'b@example.com'] }, ctx)).toBe(false);
    expect(t(match, { to: ['a@example.com'] }, { ...ctx, trust: 'unknown' })).toBe(false);
  });
});
