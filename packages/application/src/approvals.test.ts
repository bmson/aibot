import { describe, expect, it } from 'vitest';
import { rememberedApprovalPolicy } from './approvals.js';

describe('rememberedApprovalPolicy', () => {
  it('builds a recipient-scoped email rule', () => {
    expect(
      rememberedApprovalPolicy('agent-id', 'gmail.send', { to: ['Friend@Example.com'] }),
    ).toEqual({
      agentId: 'agent-id',
      toolName: 'gmail.send',
      templateKey: 'gmail.send.to_recipient',
      match: { recipient: 'friend@example.com' },
      effect: 'allow',
    });
  });

  it('creates an exact recipient-group rule', () => {
    expect(
      rememberedApprovalPolicy('agent-id', 'gmail.send', {
        to: ['one@example.com', 'two@example.com'],
      }),
    ).toMatchObject({
      templateKey: 'gmail.send.to_recipients',
      match: { recipients: ['one@example.com', 'two@example.com'] },
    });
  });

  it('rejects recipient arrays containing malformed extra entries', () => {
    expect(
      rememberedApprovalPolicy('agent-id', 'gmail.send', {
        to: ['friend@example.com', null],
      }),
    ).toBeNull();
    expect(
      rememberedApprovalPolicy('agent-id', 'gmail.send', {
        to: ['', 'friend@example.com'],
      }),
    ).toBeNull();
  });

  it('trims the sole recipient before creating the rule', () => {
    expect(
      rememberedApprovalPolicy('agent-id', 'gmail.send', { to: ['  Friend@Example.com  '] }),
    ).toMatchObject({ match: { recipient: 'friend@example.com' } });
  });

  it('never creates the rule for another tool', () => {
    expect(
      rememberedApprovalPolicy('agent-id', 'sms.send', { to: ['friend@example.com'] }),
    ).toBeNull();
  });
});

describe('additional standing approval rules', () => {
  it.each([
    ['sms.send', { to: '+14155550199' }, 'sms.send.to_recipient', { phone: '+14155550199' }],
    [
      'calendar.create_event',
      { attendees: ['B@example.com', 'a@example.com'] },
      'calendar.create_event.same_attendees',
      { attendees: ['a@example.com', 'b@example.com'] },
    ],
    ['calendar.create_event', {}, 'calendar.self_only_events', {}],
    [
      'calendar.update_event',
      { eventId: 'event-123' },
      'calendar.update_event.same_event',
      { eventId: 'event-123' },
    ],
  ])('derives the scoped rule for %s', (tool, payload, templateKey, match) => {
    expect(rememberedApprovalPolicy('agent-id', tool as string, payload)).toMatchObject({
      templateKey,
      match,
    });
  });

  it.each([
    ['sms.send', { to: 'someone' }],
    ['calendar.create_event', { attendees: ['a@example.com', null] }],
    ['calendar.update_event', { eventId: 'event-123', addAttendees: [null] }],
    ['gmail.send', { to: ['a@example.com'], attachments: [{ workspacePath: 'private.pdf' }] }],
    ['docs.share', { documentId: 'doc-123', email: 'a@example.com' }],
    ['browser.execute', { code: 'anything' }],
    ['calendar.cancel_event', { eventId: 'event-123' }],
  ])('never offers a standing rule for unsupported %s arguments', (tool, payload) => {
    expect(rememberedApprovalPolicy('agent-id', tool, payload)).toBeNull();
  });
});
