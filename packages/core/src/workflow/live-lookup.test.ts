import { describe, expect, it } from 'vitest';
import {
  detectLiveLookup,
  liveLookupFailure,
  nextLiveLookup,
  ungroundedLiveFigure,
} from './live-lookup.js';

describe('live lookup routing from home-screen regressions', () => {
  it.each([
    'What is the current SF giants score',
    'Who is the current president of Iceland',
    'Search the web',
    'Look it up, don’t think this is correct',
    'Can you find a place somewhere along the way to eat',
    'I need to find other companies to apply for. Where should I try?',
  ])('requires public evidence for %s', (content) => {
    expect(detectLiveLookup([{ role: 'user', content }])?.kind).toBe('web');
  });
  it.each(['How is the weather currently', 'How is the weather going to by work tomorrow'])(
    'checks %s',
    (content) => {
      expect(detectLiveLookup([{ role: 'user', content }])?.kind).toBe('weather');
    },
  );
  it.each([
    'How do I write hello world in JavaScript',
    'I love the rain',
    'Approved',
    'What does a president do?',
    'Do not search the web',
    'Look up the wifi password',
    'Search for my emails',
    'Investigate my calendar',
  ])('does not turn %s into a public lookup', (content) => {
    expect(detectLiveLookup([{ role: 'user', content }])).toBeUndefined();
  });
  it('resolves a typo follow-up without querying the previous assistant guess', () => {
    expect(
      detectLiveLookup([
        { role: 'user', content: 'What is the current SF giants score' },
        { role: 'assistant', content: 'I think they won 7-3.' },
        { role: 'user', content: 'Check the wcore' },
      ]),
    ).toEqual({ kind: 'web', request: 'What is the current SF giants score' });
  });
  it('continues a weather question after its missing address arrives', () => {
    expect(
      detectLiveLookup([
        { role: 'user', content: 'How is the weather by work tomorrow' },
        {
          role: 'assistant',
          content: 'Please provide your work location so I can check the weather.',
        },
        { role: 'user', content: 'I work at Zendesk 181 Fremont street San Francisco' },
      ])?.kind,
    ).toBe('weather');
  });
  it('reads a discovered source after a search and bounds automatic reads', () => {
    const lookup = { kind: 'web' as const, request: 'What is the current SF giants score' };
    const search = {
      toolName: 'web.search',
      status: 'succeeded',
      result: { results: [{ url: 'https://example.com/score' }] },
    };
    expect(nextLiveLookup(lookup, [])?.toolName).toBe('web.search');
    expect(nextLiveLookup(lookup, [search])).toEqual({
      toolName: 'web.fetch',
      input: { url: 'https://example.com/score' },
    });
    expect(
      nextLiveLookup(lookup, [search, { toolName: 'web.fetch', status: 'failed', result: null }]),
    ).toBeUndefined();
  });
  it('does not send a private lookup follow-up to public search', () => {
    expect(
      detectLiveLookup([
        { role: 'user', content: 'Find my hotel reservation in my mailbox' },
        { role: 'user', content: 'Look it up' },
      ]),
    ).toBeUndefined();
  });
  it('does not allow failed or old weather evidence to authorize a forecast', () => {
    const lookup = { kind: 'weather' as const, request: 'Weather tomorrow' };
    expect(
      liveLookupFailure(lookup, [
        { toolName: 'weather.lookup', status: 'failed', result: null },
        {
          toolName: 'weather.lookup',
          status: 'succeeded',
          result: { current: { tempC: 14 } },
          fromCurrentTask: false,
        },
      ]),
    ).toContain("can't confirm temperatures");
    expect(
      liveLookupFailure(lookup, [
        { toolName: 'weather.lookup', status: 'succeeded', result: { current: { tempC: 14 } } },
      ]),
    ).toBeUndefined();
  });
  it('treats HTTP errors embedded in tool results as failures', () => {
    expect(
      liveLookupFailure({ kind: 'web', request: 'Check the score' }, [
        {
          toolName: 'web.fetch',
          status: 'succeeded',
          result: { status: 403, text: 'AccessDenied' },
        },
      ]),
    ).toContain("haven't verified");
  });
});

describe('ungroundedLiveFigure', () => {
  const webLookup = { kind: 'web', request: 'What was the final score last night?' } as const;
  const weatherLookup = { kind: 'weather', request: 'what is the weather today' } as const;
  const fetched = (text: string) => [
    { toolName: 'web.fetch', status: 'succeeded', result: { text } } as never,
  ];

  it('blocks a score the retrieved sources never stated', () => {
    // The September failure: a batted-ball stat in a snippet reported as the score.
    const evidence = fetched('Final: San Francisco Giants 5, St. Louis Cardinals 4.');
    expect(ungroundedLiveFigure(webLookup, 'The Giants led 7-3.', evidence)).toMatch(
      /do not state 7-3/,
    );
  });

  it('accepts a score the sources do state', () => {
    const evidence = fetched('Final: San Francisco Giants 5, St. Louis Cardinals 4.');
    expect(ungroundedLiveFigure(webLookup, 'Giants won 5-4.', evidence)).toBeUndefined();
  });

  it('accepts the same score stated in the other order', () => {
    const evidence = fetched('Cardinals 4, Giants 5 (F/11)');
    expect(
      ungroundedLiveFigure(webLookup, 'It finished 5-4 to the Giants.', evidence),
    ).toBeUndefined();
  });

  it('accepts a figure that only appeared in a search snippet', () => {
    const evidence = [
      {
        toolName: 'web.search',
        status: 'succeeded',
        result: { results: [{ snippet: 'Giants 5, Cardinals 4 final' }] },
      } as never,
    ];
    expect(ungroundedLiveFigure(webLookup, 'Giants 5-4.', evidence)).toBeUndefined();
  });

  it('ignores ranges and dates that are not scorelines', () => {
    // These are the false positives that would make the rule unusable: a
    // computed range and a date are not claims about a retrieved figure.
    const evidence = fetched('The game is on.');
    expect(
      ungroundedLiveFigure(webLookup, 'Expect 10-15 minutes of delay.', evidence),
    ).toBeUndefined();
    expect(ungroundedLiveFigure(webLookup, 'Played on 2026-09-07.', evidence)).toBeUndefined();
  });

  it('stays out of requests that are not about a result', () => {
    const lookup = { kind: 'web', request: 'who is the president of Iceland' } as const;
    const evidence = fetched('Halla Tomasdottir is President.');
    expect(ungroundedLiveFigure(lookup, 'She won 34-2 in the vote.', evidence)).toBeUndefined();
  });

  it('blocks a temperature the weather data never returned', () => {
    const evidence = [
      { toolName: 'weather.lookup', status: 'succeeded', result: { tempF: 61, high: 66 } } as never,
    ];
    expect(ungroundedLiveFigure(weatherLookup, 'It is 72°F right now.', evidence)).toMatch(
      /does not contain 72/,
    );
  });

  it('accepts a temperature the weather data did return', () => {
    const evidence = [
      { toolName: 'weather.lookup', status: 'succeeded', result: { tempF: 61, high: 66 } } as never,
    ];
    expect(
      ungroundedLiveFigure(weatherLookup, 'It is 61°F, rising to 66 degrees.', evidence),
    ).toBeUndefined();
  });

  it('says nothing when no lookup succeeded, leaving that to the failure check', () => {
    const evidence = [{ toolName: 'web.fetch', status: 'failed', result: null } as never];
    expect(ungroundedLiveFigure(webLookup, 'Giants 7-3.', evidence)).toBeUndefined();
  });

  it('ignores evidence from an earlier task', () => {
    const evidence = [
      {
        toolName: 'web.fetch',
        status: 'succeeded',
        fromCurrentTask: false,
        result: { text: 'Giants 7, Cardinals 3' },
      } as never,
    ];
    expect(ungroundedLiveFigure(webLookup, 'Giants 7-3.', evidence)).toBeUndefined();
  });
});
