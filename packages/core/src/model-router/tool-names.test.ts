import { describe, expect, it } from 'vitest';
import { encodeToolNames } from './router.js';

/**
 * Regression for a silent, total tool failure: providers enforcing OpenAI's
 * function-name pattern reject dotted names, so the whole request fails before
 * the model sees any tools. That is indistinguishable from a model choosing not
 * to act — which is how a goal ran for days doing nothing.
 */
describe('tool name wire encoding', () => {
  const tools = {
    'web.fetch': { description: 'fetch', inputSchema: {} },
    'goals.update_progress': { description: 'update', inputSchema: {} },
    plain: { description: 'plain', inputSchema: {} },
  } as never;

  it('encodes dotted names to the portable pattern', () => {
    const { encoded } = encodeToolNames(tools);
    const pattern = /^[a-zA-Z0-9_-]{1,128}$/;
    for (const name of Object.keys(encoded)) expect(name).toMatch(pattern);
    expect(Object.keys(encoded)).toContain('web_fetch');
    expect(Object.keys(encoded)).toContain('goals_update_progress');
  });

  it('round-trips back to the canonical name the risk gate expects', () => {
    const { decode } = encodeToolNames(tools);
    expect(decode('web_fetch')).toBe('web.fetch');
    expect(decode('goals_update_progress')).toBe('goals.update_progress');
    expect(decode('plain')).toBe('plain');
  });

  it('preserves tool definitions unchanged', () => {
    const { encoded } = encodeToolNames(tools);
    expect((encoded as Record<string, { description: string }>).web_fetch?.description).toBe(
      'fetch',
    );
  });

  it('refuses to silently merge two tools onto one wire name', () => {
    expect(() =>
      encodeToolNames({
        'web.fetch': { description: 'a', inputSchema: {} },
        web_fetch: { description: 'b', inputSchema: {} },
      } as never),
    ).toThrow(/both encode to/);
  });
});
