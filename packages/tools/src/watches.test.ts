import { describe, expect, it } from 'vitest';
import { emailWatchMatches } from './watches.js';

const senderOnly = { expectedSenderEmails: ['recruiter@acme.example'] };
const withKeywords = {
  expectedSenderEmails: ['recruiter@acme.example'],
  keywords: ['interview', 'offer'],
};

describe('emailWatchMatches', () => {
  it('matches a named sender case-insensitively', () => {
    expect(
      emailWatchMatches(senderOnly, {
        from: 'Recruiter@Acme.Example',
        subject: 'hello',
        body: 'anything',
      }),
    ).toBe(true);
  });

  it('does not match a sender the owner never named', () => {
    expect(
      emailWatchMatches(senderOnly, {
        from: 'someone-else@acme.example',
        subject: 'hello',
        body: 'anything',
      }),
    ).toBe(false);
  });

  it('requires at least one keyword when keywords are set (subject or body)', () => {
    expect(
      emailWatchMatches(withKeywords, {
        from: 'recruiter@acme.example',
        subject: 'Your interview',
        body: 'details inside',
      }),
    ).toBe(true);
    expect(
      emailWatchMatches(withKeywords, {
        from: 'recruiter@acme.example',
        subject: 'reminder',
        body: 'we would like to extend an OFFER',
      }),
    ).toBe(true);
  });

  it('does not match when the sender is right but no keyword appears', () => {
    expect(
      emailWatchMatches(withKeywords, {
        from: 'recruiter@acme.example',
        subject: 'newsletter',
        body: 'unrelated content',
      }),
    ).toBe(false);
  });

  it('rejects an unreadable or empty match spec rather than firing', () => {
    expect(emailWatchMatches({}, { from: 'x@y.z', subject: '', body: '' })).toBe(false);
    expect(emailWatchMatches(null, { from: 'x@y.z', subject: '', body: '' })).toBe(false);
    expect(
      emailWatchMatches({ expectedSenderEmails: [] }, { from: 'x@y.z', subject: '', body: '' }),
    ).toBe(false);
  });

  it('treats an empty sender as no match', () => {
    expect(emailWatchMatches(senderOnly, { from: '   ', subject: 'hi', body: 'hi' })).toBe(false);
  });
});
