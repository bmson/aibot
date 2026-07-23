import { describe, expect, it } from 'vitest';
import { enforceResponseContract, enforceUrlProvenance } from './response-contract.js';

describe('response execution contract', () => {
  it('blocks a fabricated spreadsheet and silent background-work claim', () => {
    const result = enforceResponseContract(
      "I created a shared spreadsheet and I'll keep researching silently.",
      [],
    );
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toEqual(expect.arrayContaining(['spreadsheet', 'background']));
    expect(result.text).toContain("I couldn't verify this completed");
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

  it('blocks a fabricated approval notice that has no dispatcher record', () => {
    const result = enforceResponseContract(
      'This needs your approval before I act:\n- **[A12]** Browse Indeed\nApprove or deny it on the Approvals page — I will pick up from there.',
      [],
    );
    expect(result).toMatchObject({ blocked: true, unsupported: ['approval'] });
    expect(result.text).toContain('nothing is waiting on the Approvals page');
    expect(result.text).not.toContain('A12');
  });

  it('blocks application-submission claims even after a generic browser run', () => {
    const result = enforceResponseContract(
      'I submitted your application and saved the confirmation.',
      [{ toolName: 'browser.execute', status: 'succeeded', result: { ok: true } }],
    );
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain('application');
  });

  it('allows an application claim after an approved browser run submits and extracts a portal confirmation', () => {
    const text = 'I submitted the application. The portal confirmed it received your application.';
    expect(
      enforceResponseContract(text, [
        {
          toolName: 'browser.execute',
          status: 'succeeded',
          result: {
            ok: true,
            outputs: [
              { action: 'type', ok: true },
              { action: 'click', ok: true },
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

  it('does not accept a read-only extract of confirmation-looking page text as a submission', () => {
    // The page text is attacker-influenceable; without an actual form
    // interaction in the run it must not authorise a submission claim.
    const result = enforceResponseContract(
      'I submitted your application — the portal confirmed it received your application.',
      [
        {
          toolName: 'browser.execute',
          status: 'succeeded',
          result: {
            ok: true,
            outputs: [
              { action: 'goto', ok: true, url: 'https://careers.example/jobs' },
              {
                action: 'extract',
                text: 'Careers at Acme. Thank you for applying! Browse more open roles below.',
              },
            ],
          },
        },
      ],
    );
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain('application');
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
    "I've completed the review of the three finalists — here are my notes.",
    'I confirmed the two salary figures match.',
    "I've completed my analysis of the two offers.",
  ])('does not treat generic "completed"/"confirmed" as an application claim: %s', (text) => {
    // These verbs are ordinary English, not application submissions; without an
    // application object they must not be rewritten into failure boilerplate.
    expect(enforceResponseContract(text, [])).toMatchObject({ blocked: false, text });
  });

  it.each([
    'The hiring manager has been emailed with your follow-up.',
    'They have been notified about the schedule change.',
    'The client has been contacted.',
  ])('blocks passive-voice outbound claims with no send evidence: %s', (text) => {
    const result = enforceResponseContract(text, []);
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain('outbound');
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
    expect(result.text).toContain("Here's what I can confirm: the Google Doc action completed");
    expect(result.text).toContain("I can't yet confirm");
    expect(result.text).not.toContain("I couldn't verify this completed");
  });

  it('preserves a verified submission when a later document claim is unsupported', () => {
    const result = enforceResponseContract(
      'I submitted the application and updated the Google Doc.',
      [
        {
          toolName: 'browser.execute',
          status: 'succeeded',
          result: {
            outputs: [
              { action: 'click', ok: true },
              {
                action: 'extract',
                text: 'Thank you for applying. We have received your application.',
              },
            ],
          },
        },
      ],
    );
    expect(result).toMatchObject({ blocked: true, unsupported: ['workspace'] });
    expect(result.text).toContain('portal returned an explicit application confirmation');
    expect(result.text).toContain("can't yet confirm the requested document or file action");
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

  it('accepts a verified Google Doc text replacement', () => {
    const text = 'I updated the Google Doc.';
    expect(
      enforceResponseContract(text, [
        {
          toolName: 'docs.replace_text',
          status: 'succeeded',
          result: { documentId: 'doc-1', updated: true },
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

  it('treats a bare Workspace link as a reference, not a creation claim', () => {
    // Regression: linking a doc built in an earlier turn was rewritten into a
    // flat denial that anything had been created.
    const text =
      "Got it! I'll continue adding the itinerary details to the Google Doc as I work on them. You can track updates here:\n[Itinerary Doc](https://docs.google.com/document/d/doc-1/edit)";
    // The unbacked "I'll continue" is still caught; the link alone is not.
    expect(enforceResponseContract(text, [])).toMatchObject({ unsupported: ['background'] });
  });

  it('still catches a mutation claim made alongside a Workspace link', () => {
    const result = enforceResponseContract(
      'Created the requested Google Doc: https://docs.google.com/document/d/doc-1/edit',
      [],
    );
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain('workspace');
  });

  it('types a Workspace link claim by its URL path', () => {
    const result = enforceResponseContract(
      'I updated your sheet: https://docs.google.com/spreadsheets/d/sheet-1/edit',
      [],
    );
    expect(result.unsupported).toContain('spreadsheet');
    expect(result.unsupported).not.toContain('workspace');
  });

  it('accepts an artifact reference backed by an earlier turn in the conversation', () => {
    const text = 'I created the itinerary document.';
    expect(
      enforceResponseContract(text, [
        {
          toolName: 'docs.create',
          status: 'succeeded',
          result: { documentId: 'doc-1' },
          fromCurrentTask: false,
        },
      ]),
    ).toMatchObject({ blocked: false, text });
  });

  it('does not let an earlier artifact action justify a fresh edit claim', () => {
    const guarded = enforceResponseContract('I updated the Google Doc.', [
      {
        toolName: 'docs.create',
        status: 'succeeded',
        result: { documentId: 'doc-1' },
        fromCurrentTask: false,
      },
    ]);
    expect(guarded.blocked).toBe(true);
    expect(guarded.unsupported).toContain('workspace');
  });

  it.each([
    ['I sent the follow-up email.', 'gmail.send', { deliveryStatus: 'sent' }],
    ['I submitted the application.', 'application.submit', { confirmationId: 'app-1' }],
    ['I booked the interview on your calendar.', 'calendar.create', { eventId: 'event-1' }],
  ])(
    'does not let an earlier turn authorise a fresh outward-facing action: %s',
    (text, toolName, result) => {
      const guarded = enforceResponseContract(text, [
        { toolName, status: 'succeeded', result, fromCurrentTask: false },
      ]);
      expect(guarded.blocked).toBe(true);
    },
  );

  it('says when the verified action actually happened', () => {
    const result = enforceResponseContract('I updated the doc and sent the client an email.', [
      {
        toolName: 'docs.create',
        status: 'succeeded',
        result: { documentId: 'doc-1' },
        fromCurrentTask: false,
      },
    ]);
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain('outbound');
    expect(result.text).toContain('the Google Doc action completed earlier in this conversation');
    expect(result.text).not.toContain('I have not created');
  });

  it('blocks a memory write the model only narrated (no memory.save)', () => {
    const result = enforceResponseContract("Got it — I've corrected the birthdate in memory.", []);
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain('memory');
    expect(result.text).not.toContain('saved to memory');
  });

  it('confirms a memory write backed by a memory.save result', () => {
    const result = enforceResponseContract('Saved that correction to memory.', [
      { toolName: 'memory.save', status: 'succeeded', result: { ok: true } },
    ]);
    expect(result.blocked).toBe(false);
    expect(result.text).toBe('Saved that correction to memory.');
  });

  it('does not reprint unrelated prior-turn artifacts for an off-topic claim', () => {
    // The "update the memory" incident: a turn that claims one thing (calendar,
    // here) must not list every earlier Drive/Doc action as "confirmed".
    const result = enforceResponseContract('Added it to your calendar.', [
      {
        toolName: 'drive.download',
        status: 'succeeded',
        result: { ok: true },
        fromCurrentTask: false,
      },
      {
        toolName: 'docs.create',
        status: 'succeeded',
        result: { documentId: 'd1' },
        fromCurrentTask: false,
      },
    ]);
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain('calendar');
    expect(result.text).not.toContain('Drive file');
    expect(result.text).not.toContain('Google Doc');
  });

  it('does not report an earlier turn failure as this attempt failing', () => {
    const result = enforceResponseContract('I emailed the client.', [
      {
        toolName: 'gmail.send',
        status: 'failed',
        result: null,
        error: 'quota',
        fromCurrentTask: false,
      },
    ]);
    expect(result.blocked).toBe(true);
    expect(result.text).not.toContain('quota');
  });

  it('fails closed when a claimed email has a success status but an unknown delivery result', () => {
    const result = enforceResponseContract('The email has been delivered.', [
      { toolName: 'gmail.send', status: 'succeeded', result: { deliveryStatus: 'unknown' } },
    ]);
    expect(result.blocked).toBe(true);
    expect(result.text).toContain('gmail.send');
  });
});

describe('enforceUrlProvenance', () => {
  it('strips a fabricated bare URL and appends one note', () => {
    const { text, strippedUrls } = enforceUrlProvenance(
      'All set — confirmation here: https://acme.example/booking/9f3a',
      'the corpus mentions nothing relevant',
    );
    expect(strippedUrls).toEqual(['https://acme.example/booking/9f3a']);
    expect(text).not.toContain('acme.example');
    expect(text).toContain("couldn't trace");
  });

  it('keeps a URL that appears in the corpus (and its query-stripped form)', () => {
    const corpus = 'web.fetch finalUrl https://news.example/article/42';
    const kept = enforceUrlProvenance(
      'See https://news.example/article/42?utm=x for details.',
      corpus,
    );
    expect(kept.strippedUrls).toEqual([]);
    expect(kept.text).toContain('https://news.example/article/42?utm=x');
  });

  it('preserves the label of a stripped markdown link', () => {
    const { text, strippedUrls } = enforceUrlProvenance(
      'Read the [full report](https://fake.example/r/xyz) now.',
      'no evidence here',
    );
    expect(strippedUrls).toHaveLength(1);
    expect(text).toContain('full report');
    expect(text).not.toContain('fake.example');
  });

  it('allows a Google Doc link only when its id is in the corpus', () => {
    const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
    const evidenced = enforceUrlProvenance(
      `Doc: https://docs.google.com/document/d/${id}/edit`,
      `docs.create returned {"documentId":"${id}"}`,
    );
    expect(evidenced.strippedUrls).toEqual([]);

    const fabricated = enforceUrlProvenance(
      'Doc: https://docs.google.com/document/d/9zzzzzzzzzzzzzzzzzzzzzzzzz999999/edit',
      'no such id anywhere',
    );
    expect(fabricated.strippedUrls).toHaveLength(1);
  });

  it('allows a composed Google Maps link', () => {
    const { strippedUrls } = enforceUrlProvenance(
      'Directions: https://www.google.com/maps/search/?api=1&query=1600+Amphitheatre+Pkwy',
      'the owner asked for directions to 1600 Amphitheatre Pkwy',
    );
    expect(strippedUrls).toEqual([]);
  });

  it('emits a single note for multiple strips', () => {
    const { text } = enforceUrlProvenance('A https://a.example/x and B https://b.example/y', '');
    expect(text.match(/couldn't trace/g)).toHaveLength(1);
  });

  it('is skipped by enforceResponseContract when no corpus is provided', () => {
    const result = enforceResponseContract('Link: https://fabricated.example/z', []);
    expect(result.text).toContain('https://fabricated.example/z');
  });

  it('runs inside enforceResponseContract on an otherwise-clean answer with a corpus', () => {
    const result = enforceResponseContract('Here you go: https://fabricated.example/z', [], {
      urlCorpus: 'nothing matching',
    });
    expect(result.blocked).toBe(false);
    expect(result.text).not.toContain('fabricated.example');
  });
});
