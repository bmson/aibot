import { describe, expect, it } from 'vitest';
import { detectLiveLookup, liveLookupFailure, nextLiveLookup } from './live-lookup.js';

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
