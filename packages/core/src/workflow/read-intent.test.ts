import { describe, expect, it } from 'vitest';
import {
  buildReadToolInput,
  detectPersonalReadRequest,
  groundReadToolInput,
  nextRequiredReadTool,
  type ReadToolEvidence,
} from './read-intent.js';

const turn = (text: string, prior = '') => [
  ...(prior ? [{ role: 'assistant', content: prior }] : []),
  { role: 'user', content: text },
];

describe('detectPersonalReadRequest', () => {
  it('routes implicit day questions to all-calendar reads', () => {
    expect(detectPersonalReadRequest(turn('What is happening on Monday?'))).toMatchObject({
      kind: 'calendar',
      firstToolName: 'calendar.list_events',
    });
    expect(detectPersonalReadRequest(turn('What do I have Monday?'))).toMatchObject({
      kind: 'calendar',
      firstToolName: 'calendar.list_events',
    });
    expect(detectPersonalReadRequest(turn("What's on Monday?"))).toMatchObject({
      kind: 'calendar',
      firstToolName: 'calendar.list_events',
    });
  });

  it('searches both calendar and Gmail for a named interview', () => {
    expect(detectPersonalReadRequest(turn('When is my Clay interview?'))).toEqual({
      kind: 'calendar_email',
      queryTerms: ['clay'],
      firstToolName: 'calendar.search_events',
      requiresThreadRead: true,
      mailQuery: 'clay',
    });
  });

  it('derives a Gmail search term instead of scanning arbitrary recent mail', () => {
    expect(detectPersonalReadRequest(turn('Did I get an email from Clay?'))).toEqual({
      kind: 'email',
      queryTerms: ['clay'],
      firstToolName: 'gmail.search',
      requiresThreadRead: false,
      mailQuery: 'clay',
    });
    expect(detectPersonalReadRequest(turn('Search my email for Jane Doe'))).toMatchObject({
      kind: 'email',
      queryTerms: ['jane', 'doe'],
      mailQuery: 'jane doe',
    });
  });

  it('keeps generic inbox and importance requests broad but explicit', () => {
    expect(detectPersonalReadRequest(turn("What's in my inbox?"))).toMatchObject({
      kind: 'email',
      queryTerms: [],
      mailQuery: 'in:inbox',
    });
    expect(detectPersonalReadRequest(turn('Find any urgent email'))).toMatchObject({
      kind: 'email',
      queryTerms: [],
      mailQuery: '{is:starred is:important}',
    });
    expect(detectPersonalReadRequest(turn('Show me unread messages'))).toMatchObject({
      kind: 'email',
      queryTerms: [],
      mailQuery: 'in:inbox is:unread',
    });
    expect(detectPersonalReadRequest(turn('Check emails from last week'))).toMatchObject({
      kind: 'email',
      queryTerms: [],
      mailQuery: 'newer_than:7d',
    });
    expect(detectPersonalReadRequest(turn('Check emails from the last 3 days'))).toMatchObject({
      kind: 'email',
      queryTerms: [],
      mailQuery: 'newer_than:3d',
    });
  });

  it('lists generic meetings over the requested range without keyword narrowing', () => {
    expect(
      detectPersonalReadRequest(turn('What meetings do I have next week?'), {
        now: new Date('2026-08-13T23:00:00Z'),
        timeZone: 'America/Los_Angeles',
      }),
    ).toMatchObject({
      kind: 'calendar',
      queryTerms: [],
      firstToolName: 'calendar.list_events',
      timeWindow: { label: 'next week' },
    });
  });

  it('uses the all-calendar free/busy tool for an availability question', () => {
    const request = detectPersonalReadRequest(turn('When am I free on Monday?'), {
      now: new Date('2026-08-13T23:00:00Z'),
      timeZone: 'America/Los_Angeles',
    });
    expect(request).toMatchObject({
      kind: 'calendar',
      queryTerms: [],
      firstToolName: 'calendar.availability',
      timeWindow: {
        label: 'monday',
        timeMin: '2026-08-17T07:00:00.000Z',
        timeMax: '2026-08-18T07:00:00.000Z',
      },
    });
    expect(buildReadToolInput(request as NonNullable<typeof request>, 'calendar.availability', []))
      .toEqual({
        timeMin: '2026-08-17T07:00:00.000Z',
        timeMax: '2026-08-18T07:00:00.000Z',
      });
    expect(
      detectPersonalReadRequest(turn('Is Monday free?'), {
        now: new Date('2026-08-13T23:00:00Z'),
        timeZone: 'America/Los_Angeles',
      }),
    ).toMatchObject({ firstToolName: 'calendar.availability' });
  });

  it('resolves Monday in the owner timezone instead of letting a model choose the date', () => {
    const request = detectPersonalReadRequest(turn('What is happening on Monday?'), {
      now: new Date('2026-08-13T23:00:00Z'),
      timeZone: 'America/Los_Angeles',
    });
    expect(request).toMatchObject({
      kind: 'calendar',
      timeZone: 'America/Los_Angeles',
      timeWindow: {
        label: 'monday',
        timeMin: '2026-08-17T07:00:00.000Z',
        timeMax: '2026-08-18T07:00:00.000Z',
      },
    });
    expect(buildReadToolInput(request as NonNullable<typeof request>, 'calendar.list_events', []))
      .toEqual({
        timeMin: '2026-08-17T07:00:00.000Z',
        timeMax: '2026-08-18T07:00:00.000Z',
        maxResults: 50,
      });
  });

  it('resolves a named calendar date without asking which date the owner meant', () => {
    const request = detectPersonalReadRequest(turn('What is happening on August 17?'), {
      now: new Date('2026-08-13T23:00:00Z'),
      timeZone: 'America/Los_Angeles',
    });
    expect(request?.timeWindow).toEqual({
      label: 'August 17',
      timeMin: '2026-08-17T07:00:00.000Z',
      timeMax: '2026-08-18T07:00:00.000Z',
    });
  });

  it('uses timezone-aware day boundaries across daylight-saving changes', () => {
    const request = detectPersonalReadRequest(turn('What is happening on March 8?'), {
      now: new Date('2026-03-01T20:00:00Z'),
      timeZone: 'America/Los_Angeles',
    });
    expect(request?.timeWindow).toEqual({
      label: 'March 8',
      timeMin: '2026-03-08T08:00:00.000Z',
      timeMax: '2026-03-09T07:00:00.000Z',
    });
  });

  it('routes terse verification follow-ups using recent context', () => {
    expect(
      detectPersonalReadRequest(
        turn('Was that made up?', 'I checked your calendar and found a Linear interview.'),
      ),
    ).toMatchObject({ kind: 'calendar_email', queryTerms: ['linear'], verification: true });
    expect(
      detectPersonalReadRequest(turn('You said I had a Linear interview — why?')),
    ).toMatchObject({
      kind: 'calendar_email',
      queryTerms: ['linear'],
    });
    expect(
      detectPersonalReadRequest(
        turn(
          'Was that made up?',
          [
            'SYSTEM CHECK',
            'Looking back at Monday, August 17, 2026:',
            'Confirmed Events:',
            'Freyja’s Back-to-School Prep — 3:00 PM',
            'No Linear interview or Coffee Chat event found.',
          ].join('\n'),
        ),
      ),
    ).toMatchObject({ kind: 'calendar_email', queryTerms: ['linear'] });
    expect(
      detectPersonalReadRequest(
        turn('Are you sure?', 'I checked your email from Clay and it says Monday at 9:30.'),
      ),
    ).toMatchObject({
      kind: 'email',
      queryTerms: ['clay'],
      mailQuery: 'clay',
      requiresThreadRead: true,
    });
  });

  it('extracts the named party after the appointment noun without over-narrowing', () => {
    expect(
      detectPersonalReadRequest(turn('When is my technical interview with Clay?')),
    ).toMatchObject({ queryTerms: ['clay'] });
    expect(
      detectPersonalReadRequest(turn('When is my coffee chat with the Linear team?')),
    ).toMatchObject({ queryTerms: ['linear'] });
  });

  it('does not turn calendar mutations into read-only lookups', () => {
    expect(detectPersonalReadRequest(turn('Add lunch to my calendar Friday'))).toBeNull();
    expect(detectPersonalReadRequest(turn('Block my free time Monday afternoon'))).toBeNull();
    expect(
      detectPersonalReadRequest(turn('Go through my email and flag anything urgent')),
    ).toBeNull();
  });

  it('does not route generic interview conversation into private account reads', () => {
    expect(detectPersonalReadRequest(turn('Why do interviews make me nervous?'))).toBeNull();
  });
});

describe('required read sequence', () => {
  const detected = detectPersonalReadRequest(turn('When is my Clay interview?'));
  if (!detected) throw new Error('expected a personal read request');
  const request = detected;
  const calendar: ReadToolEvidence = {
    toolName: 'calendar.search_events',
    status: 'succeeded',
    args: { query: 'clay' },
    result: { events: [] },
  };
  const search: ReadToolEvidence = {
    toolName: 'gmail.search',
    status: 'succeeded',
    args: { query: 'clay' },
    result: { results: [{ threadId: 'thread-1', subject: 'Clay interview' }] },
  };

  it('requires calendar, then Gmail search, then the matching thread', () => {
    expect(nextRequiredReadTool(request, [])).toBe('calendar.search_events');
    expect(nextRequiredReadTool(request, [calendar])).toBe('gmail.search');
    expect(nextRequiredReadTool(request, [calendar, search])).toBe('gmail.read_thread');
    expect(
      nextRequiredReadTool(request, [
        calendar,
        search,
        {
          toolName: 'gmail.read_thread',
          status: 'succeeded',
          args: { threadId: 'thread-1' },
          result: { messages: [] },
        },
      ]),
    ).toBeUndefined();
  });

  it('still checks Gmail when the calendar source fails twice', () => {
    const failedCalendar = {
      toolName: 'calendar.search_events',
      status: 'failed',
      result: { ok: false },
    };
    expect(nextRequiredReadTool(request, [failedCalendar, failedCalendar])).toBe('gmail.search');
  });

  it('reads the first three matching Gmail threads instead of trusting one result', () => {
    const manyResults: ReadToolEvidence = {
      toolName: 'gmail.search',
      status: 'succeeded',
      args: { query: 'clay' },
      result: {
        results: [
          { threadId: 'thread-1' },
          { threadId: 'thread-2' },
          { threadId: 'thread-3' },
          { threadId: 'thread-4' },
        ],
      },
    };
    const firstRead: ReadToolEvidence = {
      toolName: 'gmail.read_thread',
      status: 'succeeded',
      args: { threadId: 'thread-1' },
      result: { messages: [{ text: 'first' }] },
    };
    const evidence = [calendar, manyResults, firstRead];
    expect(nextRequiredReadTool(request, evidence)).toBe('gmail.read_thread');
    expect(buildReadToolInput(request, 'gmail.read_thread', evidence)).toEqual({
      threadId: 'thread-2',
    });
  });

  it('binds searches to the owner wording and removes calendar narrowing', () => {
    expect(
      groundReadToolInput(
        request,
        'calendar.search_events',
        { query: 'Linear', calendarIds: ['Primary'], maxResults: 20 },
        [],
      ),
    ).toEqual({ query: 'clay', maxResults: 50 });
    expect(
      groundReadToolInput(request, 'gmail.read_thread', { threadId: 'invented' }, [search]),
    ).toEqual({ threadId: 'thread-1' });
  });

  it('does not accept a read with a model-chosen date range or Gmail query', () => {
    const dated = detectPersonalReadRequest(turn('What is happening on Monday?'), {
      now: new Date('2026-08-13T23:00:00Z'),
      timeZone: 'America/Los_Angeles',
    });
    if (!dated) throw new Error('expected a dated personal read request');
    expect(
      nextRequiredReadTool(dated, [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          args: {
            timeMin: '2026-08-24T07:00:00.000Z',
            timeMax: '2026-08-25T07:00:00.000Z',
          },
          result: { events: [] },
        },
      ]),
    ).toBe('calendar.list_events');

    expect(
      nextRequiredReadTool(request, [
        calendar,
        {
          toolName: 'gmail.search',
          status: 'succeeded',
          args: { query: 'linear' },
          result: { results: [] },
        },
      ]),
    ).toBe('gmail.search');
  });
});
