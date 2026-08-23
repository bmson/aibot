import { describe, expect, it } from 'vitest';
import {
  createCueScanner,
  cueMessageParts,
  FACE_STATES,
  MAX_TAG_LEN,
  stripCueTags,
  THEME_LOOKBACK,
  THEME_NAMES,
} from './chat-cues.js';

describe('stripCueTags extraction', () => {
  it('extracts each cue kind and strips its tag', () => {
    expect(stripCueTags('[face: warm_smile]Hey!')).toEqual({
      text: 'Hey!',
      cues: [{ kind: 'face', state: 'warm_smile' }],
    });
    expect(stripCueTags('[theme: warm_amber]Cozy now.')).toEqual({
      text: 'Cozy now.',
      cues: [{ kind: 'theme', name: 'warm_amber' }],
    });
    expect(stripCueTags('Pick one. [action_chips: "Go with A" | "Show B"]')).toEqual({
      text: 'Pick one. ',
      cues: [{ kind: 'chips', labels: ['Go with A', 'Show B'] }],
    });
  });

  it('keeps cue order across a multi-cue reply', () => {
    const { text, cues } = stripCueTags(
      '[face: warm_smile]Hi! [face: thoughtful_tilt] Two ways to do this.\n[action_chips: "Quick fix" | "Walk me through it"]',
    );
    expect(text).toBe('Hi! Two ways to do this.\n');
    expect(cues.map((cue) => cue.kind)).toEqual(['face', 'face', 'chips']);
  });

  it('repairs whitespace around an inline tag', () => {
    expect(stripCueTags('Done! [face: happy_squint] Want more?').text).toBe('Done! Want more?');
  });

  it('swallows the newline of a tag standing alone on its line', () => {
    expect(stripCueTags('Hey!\n[face: gentle_nod]\nOn it.').text).toBe('Hey!\nOn it.');
    expect(stripCueTags('[theme: cool_sky]\nMorning!').text).toBe('Morning!');
  });

  it('accepts flexible inner spacing and single-line tags only', () => {
    expect(stripCueTags('[face:curious_blink]Oh?')).toEqual({
      text: 'Oh?',
      cues: [{ kind: 'face', state: 'curious_blink' }],
    });
    expect(stripCueTags('[face:  wide_excited  ]!').cues).toEqual([
      { kind: 'face', state: 'wide_excited' },
    ]);
  });
});

describe('stripCueTags pass-through', () => {
  it.each([
    ['a markdown link', 'See [the docs](https://example.com) for more.'],
    ['a citation', 'As shown in [1] and [2].'],
    ['a missing colon', 'Try [face happy_squint] maybe.'],
    ['an unknown keyword', 'Feeling [mood: happy] today.'],
    ['a newline inside the tag', 'Broken [face: warm\nsmile] tag.'],
    ['bare brackets', 'array[0] and [ spaced ]'],
  ])('leaves %s untouched', (_label, text) => {
    expect(stripCueTags(text)).toEqual({ text, cues: [] });
  });

  it('passes through a tag that never closes within the length bound', () => {
    const text = `[face: ${'x'.repeat(MAX_TAG_LEN)}]`;
    expect(stripCueTags(text)).toEqual({ text, cues: [] });
  });

  it('rescans after a false opener and still finds a real tag', () => {
    expect(stripCueTags('[[face: warm_smile]!')).toEqual({
      text: '[!',
      cues: [{ kind: 'face', state: 'warm_smile' }],
    });
  });
});

describe('stripCueTags unknown-but-well-formed values', () => {
  it('strips an unknown face state without producing a cue', () => {
    expect(stripCueTags('Hi [face: sarcastic_wink] there.')).toEqual({
      text: 'Hi there.',
      cues: [],
    });
  });

  it('strips an unknown theme without producing a cue', () => {
    expect(stripCueTags('[theme: neon_void]Hm.')).toEqual({ text: 'Hm.', cues: [] });
  });

  it('strips a chips tag with unquoted labels without producing a cue', () => {
    expect(stripCueTags('[action_chips: yes | no]Pick.')).toEqual({ text: 'Pick.', cues: [] });
  });

  it('caps chips at four labels', () => {
    const { cues } = stripCueTags('[action_chips: "A" | "B" | "C" | "D" | "E" | "F"]');
    expect(cues).toEqual([{ kind: 'chips', labels: ['A', 'B', 'C', 'D'] }]);
  });
});

describe('createCueScanner streaming behavior', () => {
  it('holds back a chunk tail that could still become a tag', () => {
    const scanner = createCueScanner();
    expect(scanner.push('Hello [').text).toBe('Hello ');
    expect(scanner.push('fa').text).toBe('');
    expect(scanner.push('ce: warm_smile] world')).toEqual({
      text: 'world',
      cues: [{ kind: 'face', state: 'warm_smile' }],
    });
    expect(scanner.flush()).toEqual({ text: '', cues: [] });
  });

  it('holds an open chips tag across chunks until it closes', () => {
    const scanner = createCueScanner();
    expect(scanner.push('Pick: [action_chips: "A').text).toBe('Pick: ');
    const done = scanner.push('" | "B"]');
    expect(done.text).toBe('');
    expect(done.cues).toEqual([{ kind: 'chips', labels: ['A', 'B'] }]);
  });

  it('releases a held tail that turns out not to be a tag', () => {
    const scanner = createCueScanner();
    expect(scanner.push('link [').text).toBe('link ');
    expect(scanner.push('docs](url)').text).toBe('[docs](url)');
  });

  it('flushes an unterminated tag as literal text', () => {
    const scanner = createCueScanner();
    expect(scanner.push('wait [face: cur').text).toBe('wait ');
    expect(scanner.flush()).toEqual({ text: '[face: cur', cues: [] });
  });

  it('is chunking-invariant: every split of a text yields identical output', () => {
    const corpus = [
      '[face: warm_smile]Hey there! I would love to help you sort that out.',
      'Hey!\n[face: thoughtful_tilt]\nTwo ways: quick, or hands-on.\n[action_chips: "Quick & automated" | "Step-by-step guide"]',
      'Mixed [face: happy_squint] with a [link](https://example.com) and [1] citations.',
      'Unknown [face: mystery] value and [mood: off] keyword and [theme: warm_amber] mood.',
      'Edge [ bracket [f [face [face: [face: gentle_nod] done',
    ];
    for (const whole of corpus) {
      const expected = stripCueTags(whole);
      for (let a = 0; a <= whole.length; a += 1) {
        for (let b = a; b <= whole.length; b += 3) {
          const scanner = createCueScanner();
          const one = scanner.push(whole.slice(0, a));
          const two = scanner.push(whole.slice(a, b));
          const three = scanner.push(whole.slice(b));
          const tail = scanner.flush();
          expect(one.text + two.text + three.text + tail.text).toBe(expected.text);
          expect([...one.cues, ...two.cues, ...three.cues, ...tail.cues]).toEqual(expected.cues);
        }
      }
    }
  });
});

describe('cueMessageParts', () => {
  it('maps cues to AI SDK data-part shapes', () => {
    expect(
      cueMessageParts([
        { kind: 'face', state: 'wide_excited' },
        { kind: 'theme', name: 'soft_rose' },
        { kind: 'chips', labels: ['Yes', 'No'] },
      ]),
    ).toEqual([
      { type: 'data-face', data: { state: 'wide_excited' } },
      { type: 'data-theme', data: { name: 'soft_rose' } },
      { type: 'data-chips', data: { labels: ['Yes', 'No'] } },
    ]);
  });
});

describe('vocabulary', () => {
  // The web app keeps a literal duplicate of these lists (boundary rules bar
  // it from importing core); this pin and its mirror in apps/web/lib fail
  // together when either side drifts.
  it('pins the canonical face and theme lists', () => {
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
