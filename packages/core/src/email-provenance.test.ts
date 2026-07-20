import { describe, expect, it } from 'vitest';
import { quotesExternalContent } from './email-provenance.js';

describe('quotesExternalContent', () => {
  it('treats a plain owner-authored message as carrying no external content', () => {
    expect(
      quotesExternalContent({
        subject: 'dentist',
        body: 'Book me a dentist appointment Tuesday at 3pm and invite me.',
      }),
    ).toBe(false);
  });

  it('detects a Gmail forwarded message', () => {
    expect(
      quotesExternalContent({
        subject: 'Fwd: Fandango Purchase Confirmation',
        body: 'Add this to my calendar\n\n---------- Forwarded message ---------\nFrom: Fandango <fandango@movies.fandango.com>\n',
      }),
    ).toBe(true);
  });

  it('detects a forward whose subject was later replied to', () => {
    // The exact shape of the message that started this: "Re: Fwd: ...".
    expect(
      quotesExternalContent({ subject: 'Re: Fwd: Fandango Purchase Confirmation', body: 'yes' }),
    ).toBe(true);
  });

  it('detects a quoted reply block even when the subject looks clean', () => {
    expect(
      quotesExternalContent({
        subject: 'calendar',
        body: 'I want you to add it to the calendar\n\n> The Odyssey - The IMAX 2D Experience\n> Thursday, July 23, 2026\n',
      }),
    ).toBe(true);
  });

  it('detects an attribution line introducing a quote', () => {
    expect(
      quotesExternalContent({
        subject: 'calendar',
        body: 'Add it\n\nOn Sun, Jul 19, 2026 at 11:01 PM AI Bot <bot@bmson.com> wrote:\nsomething\n',
      }),
    ).toBe(true);
  });

  it('detects Apple Mail and Outlook forward separators', () => {
    expect(quotesExternalContent({ body: 'fyi\n\nBegin forwarded message:\nFrom: x' })).toBe(true);
    expect(quotesExternalContent({ body: 'fyi\n\n-----Original Message-----\nFrom: x' })).toBe(
      true,
    );
  });

  it('detects an inline reproduced header block', () => {
    expect(
      quotesExternalContent({
        subject: 'see below',
        body: 'see below\n\nFrom: someone@example.com\nSent: Monday\nTo: me\n',
      }),
    ).toBe(true);
    expect(
      quotesExternalContent({
        subject: 'see below',
        body: 'see below\n\nFrom: someone@example.com\nTo: me\nSubject: hello\n',
      }),
    ).toBe(true);
  });

  it('fails closed on empty or absent input', () => {
    // An unreadable body must never be mistaken for a body with nothing in it;
    // callers only relax the taint presumption on an explicit false, so this
    // documents that the caller — not the detector — owns that decision.
    expect(quotesExternalContent({})).toBe(false);
  });

  it('does not treat the owner mentioning a word like "forwarded" as a quote', () => {
    expect(
      quotesExternalContent({
        subject: 'note',
        body: 'I forwarded you the tickets earlier, can you check they arrived?',
      }),
    ).toBe(false);
  });
});
