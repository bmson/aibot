import { describe, expect, it } from 'vitest';
import { enforceResponseContract } from './response-contract.js';

describe('response execution contract', () => {
  it('blocks a fabricated spreadsheet and silent background-work claim', () => {
    const result = enforceResponseContract(
      "I created a shared spreadsheet and I'll keep researching silently.",
      [],
    );
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toEqual(expect.arrayContaining(['spreadsheet', 'background']));
    expect(result.text).toContain("I can't claim that work was completed");
  });

  it('blocks tracker status reports that have no durable work behind them', () => {
    const result = enforceResponseContract(
      'Mission update: the live tracker is active and 22 target companies are ready.',
      [],
    );
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toEqual(
      expect.arrayContaining(['spreadsheet', 'research', 'background']),
    );
  });

  it('blocks application-submission claims even after a generic browser run', () => {
    const result = enforceResponseContract(
      'I submitted your application and saved the confirmation.',
      [{ toolName: 'browser.execute', status: 'succeeded', result: { ok: true } }],
    );
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain('application');
  });

  it('allows an application claim after an approved browser run extracts a portal confirmation', () => {
    const text = 'I submitted the application. The portal confirmed it received your application.';
    expect(
      enforceResponseContract(text, [
        {
          toolName: 'browser.execute',
          status: 'succeeded',
          result: {
            ok: true,
            outputs: [
              {
                action: 'extract',
                text: 'Thank you for applying. We have received your application.',
              },
            ],
          },
        },
      ]),
    ).toMatchObject({ blocked: false, text });
  });

  it('allows a document claim only after a successful workspace tool', () => {
    const result = enforceResponseContract('I created the shared document.', [
      { toolName: 'docs.create', status: 'succeeded', result: { documentId: 'doc-1' } },
    ]);
    expect(result).toMatchObject({ blocked: false, text: 'I created the shared document.' });
  });

  it('does not treat an HTTP error as completed research', () => {
    const result = enforceResponseContract('I researched 22 target companies.', [
      { toolName: 'web.fetch', status: 'succeeded', result: { status: 429, text: '' } },
    ]);
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain('research');
  });

  it('keeps an explicit capability limitation and an in-chat draft intact', () => {
    const text =
      "I can't submit an application without a successful portal action. Here is a draft cover letter.";
    expect(enforceResponseContract(text, [])).toMatchObject({ blocked: false, text });
  });

  it('does not rewrite a future-tense plan as if it were a failed action', () => {
    const text =
      "I'll research senior frontend roles at AI companies, compile a shortlist, and share it for your approval. No tool action has happened yet.";
    expect(enforceResponseContract(text, [])).toMatchObject({ blocked: false, text });
  });

  it.each([
    [
      'Your spreadsheet is ready. The tracker now has 18 companies.',
      ['spreadsheet', 'research', 'background'],
    ],
    ['Sent outreach to eight engineers, and the email has been delivered.', ['outbound']],
    ['Your Vercel application is confirmed and complete.', ['application']],
    ['Application received — I saved the confirmation PDF.', ['application']],
    ['The job application went through. Applied to four additional roles.', ['application']],
    ['Your interview is booked for Tuesday and the calendar event is ready.', ['calendar']],
    ['I put it on your calendar. The meeting is set.', ['calendar']],
    ['I found and recorded 12 target companies from job boards.', ['research']],
    ['I researched the industry and browsed the competitors.', ['research']],
    ["I've emailed the hiring manager a follow-up.", ['outbound']],
    ["I'll keep handling this while you're away.", ['background']],
    ["I'll keep applying to more roles while you're away.", ['application', 'background']],
    ['Your task is running and the monitoring mission is active.', ['background']],
    [
      'Created a tracker, sent outreach to the first eight people, and submitted their applications.',
      ['spreadsheet', 'outbound', 'application'],
    ],
  ])('blocks a plausible but unevidenced status update: %s', (text, expected) => {
    const result = enforceResponseContract(text, []);
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toEqual(expect.arrayContaining(expected));
  });

  it('does not let a successful document action justify a fabricated spreadsheet or email', () => {
    const result = enforceResponseContract(
      'I created the project document, updated the spreadsheet, and sent the client email.',
      [{ toolName: 'docs.create', status: 'succeeded', result: { documentId: 'doc-1' } }],
    );
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toEqual(expect.arrayContaining(['spreadsheet', 'outbound']));
    expect(result.text).toContain('I can verify that the Google Doc action completed');
    expect(result.text).toContain('I cannot verify');
    expect(result.text).not.toContain('I have not created');
  });

  it('preserves a verified submission when a later document claim is unsupported', () => {
    const result = enforceResponseContract(
      'I submitted the application and updated the Google Doc.',
      [
        {
          toolName: 'browser.execute',
          status: 'succeeded',
          result: {
            outputs: [{ text: 'Thank you for applying. We have received your application.' }],
          },
        },
      ],
    );
    expect(result).toMatchObject({ blocked: true, unsupported: ['workspace'] });
    expect(result.text).toContain('portal returned an explicit application confirmation');
    expect(result.text).toContain('cannot verify the requested document or file action');
    expect(result.text).not.toContain('I have not submitted');
  });

  it('accepts a Sheet-backed tracker update and a durable confirmation watch', () => {
    const text =
      "I updated the application tracker. The confirmation watcher is active, and I'll keep monitoring for the receipt.";
    expect(
      enforceResponseContract(text, [
        { toolName: 'sheets.write_rows', status: 'succeeded', result: { writtenRows: 1 } },
        {
          toolName: 'applications.watch_confirmation',
          status: 'succeeded',
          result: { applicationId: 'app-1', status: 'awaiting_confirmation' },
        },
      ]),
    ).toMatchObject({ blocked: false, text });
  });

  it.each([
    ['I updated the Google Doc.', 'docs.get', { documentId: 'doc-1', text: 'existing' }],
    ['I updated the tracker.', 'sheets.get_rows', { values: [['existing']] }],
    ['I scheduled the interview.', 'calendar.list_events', { events: [] }],
  ])('does not let a read-only tool justify a mutation claim: %s', (text, toolName, result) => {
    const guarded = enforceResponseContract(text, [{ toolName, status: 'succeeded', result }]);
    expect(guarded.blocked).toBe(true);
  });

  it('accepts a verified calendar cancellation', () => {
    const text = 'I cancelled the calendar event.';
    expect(
      enforceResponseContract(text, [
        {
          toolName: 'calendar.cancel_event',
          status: 'succeeded',
          result: { eventId: 'event-1', status: 'cancelled' },
        },
      ]),
    ).toMatchObject({ blocked: false, text });
  });

  it('allows a complex report only when every claimed action has matching success evidence', () => {
    const text =
      'I created the spreadsheet, sent the email, scheduled the interview, and submitted the application.';
    expect(
      enforceResponseContract(text, [
        { toolName: 'sheets.create', status: 'succeeded', result: { spreadsheetId: 'sheet-1' } },
        { toolName: 'gmail.send', status: 'succeeded', result: { deliveryStatus: 'sent' } },
        { toolName: 'calendar.create', status: 'succeeded', result: { eventId: 'event-1' } },
        {
          toolName: 'application.submit',
          status: 'succeeded',
          result: { confirmationId: 'app-1' },
        },
      ]),
    ).toMatchObject({ blocked: false, text });
  });

  it('fails closed when a claimed email has a success status but an unknown delivery result', () => {
    const result = enforceResponseContract('The email has been delivered.', [
      { toolName: 'gmail.send', status: 'succeeded', result: { deliveryStatus: 'unknown' } },
    ]);
    expect(result.blocked).toBe(true);
    expect(result.text).toContain('gmail.send');
  });
});
