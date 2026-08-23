import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  chipsOf,
  FACE_STATES,
  faceCueOf,
  latestFace,
  latestTheme,
  THEME_LOOKBACK,
  THEME_NAMES,
  themeCueOf,
} from './chat-cues';

function assistantMessage(id: string, parts: unknown[]): UIMessage {
  return { id, role: 'assistant', parts } as UIMessage;
}

describe('vocabulary', () => {
  // Literal mirror of packages/core/src/chat-cues.ts — the boundary rules bar
  // this app from importing core, so the two copies are pinned by twin tests
  // that fail together when either side drifts.
  it('matches the canonical face and theme lists in @assistant/core', () => {
    expect(FACE_STATES).toEqual([
      'neutral',
      'warm_smile',
      'happy_squint',
      'curious_blink',
      'thoughtful_tilt',
      'wide_excited',
      'gentle_nod',
      'focused',
    ]);
    expect(THEME_NAMES).toEqual(['default', 'warm_amber', 'soft_rose', 'cool_sky']);
    // Also mirrored into apps/ios (CompanionMood.lookback).
    expect(THEME_LOOKBACK).toBe(8);
  });
});

describe('cue part readers', () => {
  it('reads the newest known face cue and skips unknown values', () => {
    const message = assistantMessage('m1', [
      { type: 'data-face', data: { state: 'warm_smile' } },
      { type: 'text', text: 'Hi!' },
      { type: 'data-face', data: { state: 'wide_excited' } },
      { type: 'data-face', data: { state: 'sarcastic_wink' } },
    ]);
    expect(faceCueOf(message)).toBe('wide_excited');
  });

  it('returns null when a message carries no face cue', () => {
    expect(faceCueOf(assistantMessage('m1', [{ type: 'text', text: 'Hi!' }]))).toBeNull();
  });

  it('reads theme cues the same way', () => {
    const message = assistantMessage('m1', [
      { type: 'data-theme', data: { name: 'warm_amber' } },
      { type: 'data-theme', data: { name: 'neon_void' } },
    ]);
    expect(themeCueOf(message)).toBe('warm_amber');
  });

  it('re-caps chip labels defensively', () => {
    const message = assistantMessage('m1', [
      {
        type: 'data-chips',
        data: { labels: ['One', ' Two ', '', 42, 'x'.repeat(61), 'Three', 'Four', 'Five'] },
      },
    ]);
    expect(chipsOf(message)).toEqual(['One', 'Two', 'Three', 'Four']);
  });

  it('returns no chips for malformed data', () => {
    expect(
      chipsOf(assistantMessage('m1', [{ type: 'data-chips', data: { labels: 'Yes' } }])),
    ).toEqual([]);
    expect(chipsOf(assistantMessage('m2', [{ type: 'text', text: 'Hi' }]))).toEqual([]);
  });
});

describe('log-level cues', () => {
  const log = [
    assistantMessage('m1', [
      { type: 'text', text: 'One' },
      { type: 'data-face', data: { state: 'happy_squint' } },
      { type: 'data-theme', data: { name: 'cool_sky' } },
    ]),
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Reply' }] } as UIMessage,
    assistantMessage('m2', [{ type: 'text', text: 'Two' }]),
  ];

  it('rests on the newest assistant cue, looking past cue-less replies', () => {
    expect(latestFace(log)).toBe('happy_squint');
    expect(latestTheme(log)).toBe('cool_sky');
  });

  it('defaults to neutral and the default theme on an empty or cue-less log', () => {
    expect(latestFace([])).toBe('neutral');
    expect(latestTheme([])).toBe('default');
    const plain = [assistantMessage('m1', [{ type: 'text', text: 'Hi' }])];
    expect(latestFace(plain)).toBe('neutral');
    expect(latestTheme(plain)).toBe('default');
  });
});

describe('theme lookback', () => {
  const themed = () =>
    assistantMessage('themed', [{ type: 'data-theme', data: { name: 'cool_sky' } }]);
  const plain = (id: string) => assistantMessage(id, [{ type: 'text', text: 'Working on it' }]);
  const owner = (id: string) =>
    ({ id, role: 'user', parts: [{ type: 'text', text: 'Thanks' }] }) as UIMessage;

  it('still applies a cue at the edge of the lookback', () => {
    const log = [
      themed(),
      ...Array.from({ length: THEME_LOOKBACK - 1 }, (_, index) => plain(`m${index}`)),
    ];
    expect(latestTheme(log)).toBe('cool_sky');
  });

  it('lets a cue decay once it falls past the lookback', () => {
    const log = [
      themed(),
      ...Array.from({ length: THEME_LOOKBACK }, (_, index) => plain(`m${index}`)),
    ];
    expect(latestTheme(log)).toBe('default');
  });

  it('does not spend budget on owner messages', () => {
    const log = [
      themed(),
      ...Array.from({ length: 40 }, (_, index) => owner(`u${index}`)),
      plain('m0'),
    ];
    expect(latestTheme(log)).toBe('cool_sky');
  });

  it('prefers the newest cue when two are in range', () => {
    const log = [
      themed(),
      assistantMessage('m0', [{ type: 'data-theme', data: { name: 'warm_amber' } }]),
    ];
    expect(latestTheme(log)).toBe('warm_amber');
  });
});
