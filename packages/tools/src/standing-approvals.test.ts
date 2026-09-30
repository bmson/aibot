import { approvalRule } from '@assistant/core/approval-rule';
import { describe, expect, it } from 'vitest';
import { policyTemplates } from './policies.js';
import type { ToolContext } from './types.js';

const owner = { trust: 'owner' } as ToolContext;
const brief = {
  to: '+14155550199',
  goal: 'Ask opening hours',
  context: 'First name only',
  mayAgreeTo: 'Nothing',
  mustNot: 'Do not make purchases',
  maxMinutes: 5,
  onVoicemail: 'hang_up',
};

const examples = [
  {
    tool: 'gmail.send',
    args: { to: ['b@example.com', 'a@example.com'] },
    allowed: { to: ['A@example.com', 'b@example.com'] },
    refused: [
      { to: ['a@example.com'] },
      { to: ['a@example.com', 'b@example.com', 'c@example.com'] },
      { to: ['a@example.com', 'b@example.com'], attachments: [{ workspacePath: 'private.pdf' }] },
    ],
  },
  {
    tool: 'gmail.modify',
    args: { archive: true, markRead: true },
    allowed: {
      messageId: 'different-message',
      archive: true,
      markRead: true,
      addLabels: [],
      removeLabels: [],
    },
    refused: [
      { archive: true },
      { archive: true, markRead: false },
      { archive: true, markRead: true, addLabels: ['TRASH'] },
      { archive: true, markRead: true, removeLabels: ['STARRED'] },
    ],
  },
  {
    tool: 'calendar.respond_to_event',
    args: { calendarId: 'work', response: 'accepted' },
    allowed: {
      calendarId: 'work',
      eventId: 'another-invitation',
      response: 'accepted',
      comment: '',
    },
    refused: [
      { calendarId: 'personal', response: 'accepted' },
      { calendarId: 'work', response: 'declined' },
      { calendarId: 'work', response: 'accepted', comment: 'Private details' },
    ],
  },
  {
    tool: 'calendar.update_event',
    args: { eventId: 'event-123', addAttendees: ['a@example.com'] },
    allowed: { eventId: 'event-123', summary: 'New title', addAttendees: ['A@example.com'] },
    refused: [
      { eventId: 'event-456', addAttendees: ['a@example.com'] },
      { eventId: 'event-123', addAttendees: ['a@example.com', 'b@example.com'] },
      { eventId: 'event-123' },
    ],
  },
  {
    tool: 'docs.share',
    args: { documentId: 'document-123456', email: 'a@example.com', role: 'reader' },
    allowed: { documentId: 'another-document-123', email: 'A@example.com', role: 'reader' },
    refused: [
      { documentId: 'document-123456', email: 'b@example.com', role: 'reader' },
      { documentId: 'document-123456', email: 'a@example.com', role: 'writer' },
    ],
  },
  {
    tool: 'phone.call',
    args: { brief },
    allowed: { brief: { ...brief, maxMinutes: 3 } },
    refused: [
      { brief: { ...brief, maxMinutes: 6 } },
      { brief: { ...brief, to: '+14155550200' } },
      { brief: { ...brief, context: 'Share address too' } },
      { brief: { ...brief, mayAgreeTo: 'Buy anything' } },
      { brief: { ...brief, mustNot: '' } },
      { brief: { ...brief, goal: 'Make a purchase' } },
      { brief: { ...brief, onVoicemail: 'leave_message', voicemailMessage: 'Private details' } },
      { brief: { ...brief, language: 'Spanish' } },
    ],
  },
];

describe('additional saved approval scopes', () => {
  for (const example of examples) {
    it(`${example.tool} permits only the explicit saved scope`, () => {
      const rule = approvalRule(example.tool, example.args);
      if (!rule) throw new Error('Expected a saveable action');
      const matches = policyTemplates[rule.templateKey];
      if (!matches) throw new Error('Missing enforcement template');
      expect(matches(rule.match, example.allowed, owner)).toBe(true);
      // JSONB reorders object keys; that must not change a saved permission.
      const reordered = Object.fromEntries(Object.entries(rule.match).reverse());
      expect(matches(reordered, example.allowed, owner)).toBe(true);
      for (const args of example.refused) expect(matches(rule.match, args, owner)).toBe(false);
      expect(matches(rule.match, example.allowed, { ...owner, trust: 'unknown' })).toBe(false);
    });
  }

  it.each([
    ['gmail.modify', { archive: true, addLabels: ['TRASH'] }],
    ['calendar.respond_to_event', { response: 'accepted', comment: 'My address' }],
    ['docs.share', { documentId: 'document-123456', email: 'a@example.com', role: 'owner' }],
    ['phone.call', { brief: { ...brief, maxMinutes: NaN } }],
    ['phone.call', { brief: { ...brief, context: null } }],
    ['phone.call', { brief: { ...brief, newInstruction: 'Share anything' } }],
    ['phone.call', { brief: { ...brief, context: null, onVoicemail: 'invalid' } }],
    ['browser.execute', { code: 'anything' }],
  ])('does not offer an unsupported scope for %s', (tool, args) => {
    expect(approvalRule(tool as string, args)).toBeNull();
  });
});
