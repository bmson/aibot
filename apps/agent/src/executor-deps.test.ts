import { describe, expect, it } from 'vitest';
import { approvalNoticeEmail } from './executor-deps.js';

describe('approvalNoticeEmail', () => {
  const notice = approvalNoticeEmail([
    { shortCode: 'A7', summary: 'Create event "The Odyssey" 2026-07-23T18:00 and invite owner' },
  ]);

  it('names every pending approval with its code', () => {
    expect(notice).toContain('A7');
    expect(notice).toContain('The Odyssey');
  });

  it('states plainly that nothing has happened yet', () => {
    // The whole point of the parked notice: the owner must not read it as a
    // completion. This is the same failure the response contract exists to stop.
    expect(notice).toMatch(/nothing has happened yet/i);
  });

  it('does not invite an email reply, which cannot resolve an approval', () => {
    // Only sms-channel parses "YES A7". Telling the owner to reply to the email
    // would be an instruction the system silently drops.
    expect(notice).not.toMatch(/reply to this email/i);
    expect(notice).toMatch(/dashboard/i);
    expect(notice).toMatch(/text message/i);
  });

  it('lists each approval when several park together', () => {
    const many = approvalNoticeEmail([
      { shortCode: 'A8', summary: 'first' },
      { shortCode: 'A9', summary: 'second' },
    ]);
    expect(many).toContain('[A8] first');
    expect(many).toContain('[A9] second');
  });
});
