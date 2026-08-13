import { describe, expect, it } from 'vitest';
import {
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
  });

  it('searches both calendar and Gmail for a named interview', () => {
    expect(detectPersonalReadRequest(turn('When is my Clay interview?'))).toEqual({
      kind: 'calendar_email',
      queryTerms: ['clay'],
      firstToolName: 'calendar.search_events',
      requiresThreadRead: true,
    });
  });

  it('routes terse verification follow-ups using recent context', () => {
    expect(
      detectPersonalReadRequest(
        turn('Was that made up?', 'I checked your calendar and found a Linear interview.'),
      ),
    ).toMatchObject({ kind: 'calendar' });
    expect(
      detectPersonalReadRequest(turn('You said I had a Linear interview — why?')),
    ).toMatchObject({
      kind: 'calendar_email',
      queryTerms: ['linear'],
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
    result: { events: [] },
  };
  const search: ReadToolEvidence = {
    toolName: 'gmail.search',
    status: 'succeeded',
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

  it('binds searches to the owner wording and removes calendar narrowing', () => {
    expect(
      groundReadToolInput(
        request,
        'calendar.search_events',
        { query: 'Linear', calendarIds: ['Primary'], maxResults: 20 },
        [],
      ),
    ).toEqual({ query: 'clay', maxResults: 20 });
    expect(
      groundReadToolInput(request, 'gmail.read_thread', { threadId: 'invented' }, [search]),
    ).toEqual({ threadId: 'thread-1' });
  });
});
