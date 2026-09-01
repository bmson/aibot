import { describe, expect, it } from 'vitest';
import {
  availabilityResponseCards,
  calendarResponseCards,
  responseCardsForFinal,
  searchResponseCards,
  sheetRowsResponseCards,
  statusResponseCards,
  threadResponseCards,
  weatherResponseCards,
} from './response-cards.js';

const request = {
  kind: 'calendar' as const,
  timeZone: 'America/Los_Angeles',
  queryTerms: [],
  firstToolName: 'calendar.list_events' as const,
  requiresThreadRead: false,
};

describe('response cards', () => {
  it('merges obvious cross-calendar twins but keeps distinct appointments', () => {
    const result = calendarResponseCards(
      [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          result: {
            events: [
              {
                eventId: 'family',
                calendarId: 'family',
                calendar: 'Family',
                summary: "Frejya's playdate",
                location: "Gweny's house",
                start: '2026-08-24T14:00:00-07:00',
                end: '2026-08-24T17:00:00-07:00',
              },
              {
                eventId: 'work',
                calendarId: 'work',
                calendar: 'Work',
                summary: "Frejya's playdate",
                location: "Gweny's house",
                start: '2026-08-24T14:00:00-07:00',
                end: '2026-08-24T17:00:00-07:00',
              },
              {
                eventId: 'soccer',
                calendarId: 'family',
                calendar: 'Family',
                summary: 'Soccer',
                location: 'PayPal Park',
                start: '2026-08-24T14:00:00-07:00',
                end: '2026-08-24T17:00:00-07:00',
              },
            ],
          },
        },
      ],
      request,
    );
    expect(result).toHaveLength(2);
    expect(result[0]?.calendars).toEqual(['Family', 'Work']);
  });

  it('builds calendar cards from successful evidence even when wording detection missed', () => {
    const result = calendarResponseCards([
      {
        toolName: 'calendar.list_events',
        status: 'succeeded',
        result: {
          events: [
            {
              eventId: 'coffee',
              calendarId: 'family',
              calendar: 'Family',
              summary: 'Coffee with Tine',
              start: '2026-09-02T09:00:00-07:00',
              end: '2026-09-02T10:00:00-07:00',
            },
          ],
        },
      },
    ]);
    expect(result).toMatchObject([
      { kind: 'calendar-event', title: 'Coffee with Tine', time: '9:00 AM–10:00 AM' },
    ]);
  });

  it('keeps an event calendar link separate from its video meeting link', () => {
    const result = calendarResponseCards(
      [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          result: {
            events: [
              {
                eventId: 'review',
                calendarId: 'work',
                calendar: 'Work',
                summary: 'Design review',
                start: '2026-08-24T14:00:00-07:00',
                end: '2026-08-24T15:00:00-07:00',
                links: [
                  {
                    type: 'calendar',
                    label: 'Open in Google Calendar',
                    url: 'https://calendar.google.com/event?eid=review',
                  },
                  { type: 'video', label: 'Video meeting', url: 'https://zoom.us/j/12345' },
                ],
              },
            ],
          },
        },
      ],
      request,
    );

    expect(result).toMatchObject([
      {
        calendarLink: { url: 'https://calendar.google.com/event?eid=review' },
        meetingLink: { url: 'https://zoom.us/j/12345' },
        link: { url: 'https://calendar.google.com/event?eid=review' },
      },
    ]);
  });

  it('turns the fresh ambient weather block into a compact card', () => {
    expect(
      weatherResponseCards(
        "Right now (ambient context):\nOwner's current location: near San Francisco (37.7749, -122.4194), as of just now.\nWeather there: overcast, 18°C (today 17–19°C, 2% chance of rain, wind 18 km/h, humidity 70%).",
      ),
    ).toMatchObject([
      {
        kind: 'weather',
        location: 'San Francisco',
        temperature: '18°C',
        details: [
          { label: 'Today', value: '17–19°C' },
          { label: 'Wind', value: '18 km/h' },
          { label: 'Humidity', value: '70%' },
          { label: 'Rain chance', value: '2%' },
        ],
      },
    ]);
  });

  it('carries the coming days as day-labeled details for the card to group', () => {
    expect(
      weatherResponseCards(
        "Right now (ambient context):\nOwner's current location: near San Francisco (37.7749, -122.4194), as of just now.\nWeather there: overcast, 18°C (today 17–19°C, 2% chance of rain, wind 18 km/h).\nComing days: Tue 16–23°C, clear; Wed 14–21°C, light rain, 80% chance of rain.",
      ),
    ).toMatchObject([
      {
        kind: 'weather',
        details: [
          { label: 'Today', value: '17–19°C' },
          { label: 'Wind', value: '18 km/h' },
          { label: 'Rain chance', value: '2%' },
          { label: 'Tue', value: '16–23°C, clear' },
          { label: 'Wed', value: '14–21°C, light rain, 80% chance of rain' },
        ],
      },
    ]);
  });

  it('attaches the ambient card to a plain here-and-now weather question', () => {
    const result = responseCardsForFinal({
      evidence: [],
      ambient:
        "Right now (ambient context):\nOwner's current location: near San Francisco (37.7749, -122.4194), as of just now.\nWeather there: overcast, 18°C (today 17–19°C, 2% chance of rain, wind 18 km/h).",
      requestText: "what's the weather like?",
    });

    expect(result.map((card) => card.kind)).toEqual(['weather']);
  });

  it.each([
    "what's the weather in Palo Alto this weekend?",
    "what's the weather this weekend?",
    'will it rain tomorrow?',
    'how hot will it get on Saturday?',
    'weather for Tokyo next week?',
  ])('keeps the today-here ambient card off an answer it would contradict: %s', (requestText) => {
    const result = responseCardsForFinal({
      evidence: [],
      ambient:
        "Right now (ambient context):\nOwner's current location: near San Francisco (37.7749, -122.4194), as of just now.\nWeather there: overcast, 18°C (today 17–19°C, 2% chance of rain, wind 18 km/h).\nComing days: Sat 16–23°C, clear; Sun 14–21°C, light rain.",
      requestText,
    });

    expect(result).toEqual([]);
  });

  it('builds complete cards for reminders, inbox, documents, Drive, artifacts, and confirmations', () => {
    const result = responseCardsForFinal({
      evidence: [
        {
          toolName: 'reminder.create',
          status: 'succeeded',
          result: {
            reminderId: 'reminder-1',
            text: '**Review** the launch plan',
            cron: '0 9 * * 1',
            nextFires: '2026-08-31T16:00:00.000Z',
          },
        },
        {
          toolName: 'gmail.search',
          status: 'succeeded',
          args: { query: 'launch' },
          result: {
            mailboxSearched: 'owner@example.com',
            complete: false,
            matchingMessagesEstimate: 3,
            results: [
              {
                messageId: 'message-1',
                threadId: 'thread-1',
                from: 'Ada <ada@example.com>',
                to: 'owner@example.com',
                subject: '**Launch** update',
                date: 'Mon, 24 Aug 2026 09:00:00 -0700',
                snippet: 'The plan is ready.',
              },
            ],
          },
        },
        {
          toolName: 'documents.search',
          status: 'succeeded',
          args: { query: 'launch plan' },
          result: {
            passages: [
              {
                document: 'Launch brief',
                source: 'upload',
                snippet: 'The **launch** is scheduled for Monday.',
                similarity: 0.982,
              },
            ],
          },
        },
        {
          toolName: 'drive.search',
          status: 'succeeded',
          args: { query: 'launch' },
          result: {
            files: [
              {
                fileId: 'drive-1',
                name: 'Launch deck',
                mimeType: 'application/vnd.google-apps.presentation',
                modifiedTime: '2026-08-24T16:00:00.000Z',
                size: '2048',
                url: 'https://drive.example.com/launch',
              },
            ],
          },
        },
        {
          toolName: 'docs.create',
          status: 'succeeded',
          args: { title: 'Launch recap' },
          result: {
            documentId: 'doc-1',
            title: 'Launch recap',
            sharedWith: 'owner@example.com',
            url: 'https://docs.example.com/launch-recap',
          },
        },
        {
          toolName: 'gmail.create_draft',
          status: 'succeeded',
          args: { to: ['ada@example.com'], subject: '**Launch** recap' },
          result: { draftId: 'draft-1', to: ['ada@example.com'], subject: '**Launch** recap' },
        },
      ],
    });

    expect(result).toMatchObject([
      {
        kind: 'resource',
        resourceType: 'document',
        title: 'Launch recap',
        link: { label: 'Open document', url: 'https://docs.example.com/launch-recap' },
      },
      {
        kind: 'status',
        title: 'Email draft ready',
        detail: '**Launch** recap',
        details: [{ label: 'To', value: 'ada@example.com' }],
      },
      {
        kind: 'reminder',
        title: '**Review** the launch plan',
        schedule: '0 9 * * 1',
      },
      {
        kind: 'email-results',
        complete: false,
        matchingMessagesEstimate: 3,
        messages: [{ subject: '**Launch** update', snippet: 'The plan is ready.' }],
      },
      {
        kind: 'document-results',
        passages: [{ document: 'Launch brief', source: 'upload', similarity: 0.982 }],
      },
      {
        kind: 'drive-results',
        files: [{ name: 'Launch deck', size: '2048' }],
      },
    ]);
  });

  it('turns web search hits into a tappable results card', () => {
    const result = searchResponseCards([
      {
        toolName: 'web.search',
        status: 'succeeded',
        args: { query: 'best time to visit Lisbon' },
        result: {
          query: 'best time to visit Lisbon',
          results: [
            {
              url: 'https://example.com/lisbon',
              title: 'Lisbon travel guide',
              snippet: 'Late spring is ideal.',
            },
            { url: '', title: 'Dropped without a URL', snippet: 'No link.' },
          ],
        },
      },
      { toolName: 'web.search', status: 'failed', result: { query: 'ignored', results: [] } },
    ]);

    expect(result).toMatchObject([
      {
        kind: 'web-search-results',
        query: 'best time to visit Lisbon',
        results: [
          {
            title: 'Lisbon travel guide',
            url: 'https://example.com/lisbon',
            snippet: 'Late spring is ideal.',
          },
        ],
      },
    ]);
    expect(result[0]?.results).toHaveLength(1);
  });

  it('turns a free/busy read into an availability card with its coverage', () => {
    const result = availabilityResponseCards([
      {
        toolName: 'calendar.availability',
        status: 'succeeded',
        args: { timeMin: '2026-08-24T09:00:00-07:00', timeMax: '2026-08-24T17:00:00-07:00' },
        result: {
          busy: [
            {
              start: '2026-08-24T10:00:00-07:00',
              end: '2026-08-24T11:30:00-07:00',
              calendar: 'Work',
            },
            { start: '', end: '', calendar: 'Dropped when malformed' },
          ],
          calendarsChecked: ['Work', 'Family'],
          complete: false,
          note: 'Some calendars did not return free/busy data.',
        },
      },
    ]);

    expect(result).toMatchObject([
      {
        kind: 'availability',
        timeMin: '2026-08-24T09:00:00-07:00',
        timeMax: '2026-08-24T17:00:00-07:00',
        busy: [
          {
            start: '2026-08-24T10:00:00-07:00',
            end: '2026-08-24T11:30:00-07:00',
            calendar: 'Work',
          },
        ],
        calendarsChecked: ['Work', 'Family'],
        complete: false,
        note: 'Some calendars did not return free/busy data.',
      },
    ]);
    expect(result[0]?.busy).toHaveLength(1);
  });

  it('includes search and availability cards in the final response set', () => {
    const result = responseCardsForFinal({
      evidence: [
        {
          toolName: 'web.search',
          status: 'succeeded',
          args: { query: 'lisbon' },
          result: {
            query: 'lisbon',
            results: [{ url: 'https://example.com', title: 'Example', snippet: 'Hi' }],
          },
        },
        {
          toolName: 'calendar.availability',
          status: 'succeeded',
          args: { timeMin: '2026-08-24T09:00:00-07:00', timeMax: '2026-08-24T17:00:00-07:00' },
          result: { busy: [], calendarsChecked: ['Work'], complete: true },
        },
      ],
    });

    expect(result.map((card) => card.kind)).toEqual(['availability', 'web-search-results']);
  });

  it('turns a fetched thread into a compact transcript card', () => {
    const result = threadResponseCards([
      {
        toolName: 'gmail.read_thread',
        status: 'succeeded',
        result: {
          threadId: 'thread-1',
          messages: [
            {
              messageId: 'm1',
              from: 'Ada <ada@example.com>',
              date: 'Mon, 24 Aug 2026 09:00:00 -0700',
              subject: 'Launch recap',
              text: 'The plan is ready.\n\nEverything reviewed.',
            },
            {
              messageId: 'm2',
              from: 'owner@example.com',
              date: 'Mon, 24 Aug 2026 09:15:00 -0700',
              subject: 'Re: Launch recap',
              text: 'Thanks!',
            },
          ],
        },
      },
    ]);

    expect(result).toMatchObject([
      {
        kind: 'email-thread',
        subject: 'Launch recap',
        messageCount: 2,
        messages: [
          {
            id: 'm1',
            sender: 'Ada <ada@example.com>',
            excerpt: 'The plan is ready. Everything reviewed.',
          },
          { id: 'm2', excerpt: 'Thanks!' },
        ],
      },
    ]);
  });

  it('caps sheet previews while keeping the full row count and open link', () => {
    const wideRow = Array.from({ length: 8 }, (_, index) => `col-${index}`);
    const result = sheetRowsResponseCards([
      {
        toolName: 'sheets.get_rows',
        status: 'succeeded',
        result: {
          spreadsheetId: 'sheet-1',
          sheetName: 'Budget',
          url: 'https://sheets.example.com/budget',
          rows: [wideRow, ['Flights', 640], ...Array.from({ length: 40 }, () => ['x', 1])],
        },
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'sheet-rows',
      sheetName: 'Budget',
      totalRows: 42,
      link: { label: 'Open spreadsheet', url: 'https://sheets.example.com/budget' },
    });
    const rows = result[0]?.rows as string[][];
    expect(rows).toHaveLength(9);
    expect(rows[0]).toHaveLength(6);
    expect(rows[1]).toEqual(['Flights', '640']);
  });

  it('confirms inbox, document, and sheet writes with links where they exist', () => {
    const result = statusResponseCards([
      {
        toolName: 'gmail.modify',
        status: 'succeeded',
        args: { messageId: 'm1', archive: true, markRead: true },
        result: { id: 'm1', addedLabels: [], removedLabels: ['UNREAD', 'INBOX'] },
      },
      {
        toolName: 'docs.append',
        status: 'succeeded',
        result: { documentId: 'doc-1', url: 'https://docs.example.com/1', appended: true },
      },
      {
        toolName: 'docs.replace_text',
        status: 'succeeded',
        result: {
          documentId: 'doc-1',
          url: 'https://docs.example.com/1',
          updated: true,
          replacements: [{ oldText: 'a', newText: 'b' }],
        },
      },
      {
        toolName: 'docs.share',
        status: 'succeeded',
        args: { role: 'commenter' },
        result: {
          documentId: 'doc-1',
          url: 'https://docs.example.com/1',
          sharedWith: 'ada@example.com',
        },
      },
      {
        toolName: 'sheets.append_rows',
        status: 'succeeded',
        result: {
          spreadsheetId: 's1',
          sheetName: 'Budget',
          url: 'https://sheets.example.com/budget',
          appendedRows: 3,
        },
      },
      {
        toolName: 'sheets.write_rows',
        status: 'succeeded',
        result: {
          spreadsheetId: 's1',
          sheetName: 'Budget',
          startCell: 'B4',
          url: 'https://sheets.example.com/budget',
          writtenRows: 1,
        },
      },
    ]);

    expect(result).toMatchObject([
      { kind: 'status', title: 'Inbox updated', detail: 'Archived · Marked read' },
      {
        kind: 'status',
        title: 'Document updated',
        symbol: 'doc.badge.plus',
        link: { label: 'Open document', url: 'https://docs.example.com/1' },
      },
      {
        kind: 'status',
        title: 'Document updated',
        detail: '1 text replacement applied.',
      },
      {
        kind: 'status',
        title: 'Document shared',
        detail: 'ada@example.com',
        details: [{ label: 'Role', value: 'commenter' }],
      },
      {
        kind: 'status',
        title: 'Sheet updated',
        detail: '3 rows added to Budget.',
        link: { label: 'Open spreadsheet', url: 'https://sheets.example.com/budget' },
      },
      { kind: 'status', title: 'Sheet updated', detail: '1 row written to Budget.' },
    ]);
  });

  it('does not revive cards from an earlier task in the conversation', () => {
    expect(
      responseCardsForFinal({
        evidence: [
          {
            toolName: 'gmail.send',
            status: 'succeeded',
            fromCurrentTask: false,
            result: { messageId: 'old-message', to: ['person@example.com'] },
          },
        ],
      }),
    ).toEqual([]);
  });
});
