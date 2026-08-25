import { describe, expect, it } from 'vitest';
import {
  calendarResponseCards,
  responseCardsForFinal,
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
