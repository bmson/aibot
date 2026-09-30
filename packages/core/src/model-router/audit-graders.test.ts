import { describe, expect, it } from 'vitest';
import {
  type AuditDefectKind,
  explicitlyRequestsRepetition,
  gradeAuditedOutput,
  repairPresentationDefects,
} from './audit-graders.js';

const kinds = (text: string | null | undefined, options = {}): AuditDefectKind[] =>
  gradeAuditedOutput(text, options).map((defect) => defect.kind);

describe('gradeAuditedOutput', () => {
  it('passes ordinary prose', () => {
    expect(kinds('Two things today: the dentist at 09:00 and the Q3 review at 14:00.')).toEqual([]);
  });

  it('passes a balanced code fence', () => {
    expect(kinds('Here:\n```js\nconsole.log(1);\n```\nThat runs it.')).toEqual([]);
  });

  it('flags an unclosed code fence', () => {
    expect(kinds('Here:\n```js\nconsole.log(1);')).toEqual(['unclosed-code-fence']);
  });

  it('flags the background-notice marker echoed into a reply', () => {
    // The exact failure the javascript-background-notice regression covers.
    expect(kinds('[Background notice — not a reply] A birthday reminder fired.')).toContain(
      'background-notice-echo',
    );
  });

  it('flags a theme tag, which the cue vocabulary forbids outright', () => {
    expect(kinds('[theme: sunset] Here is your day.')).toContain('forbidden-theme-tag');
  });

  it('accepts the cue tags that are legitimate', () => {
    expect(kinds('First thing.\n[break]\nSecond thing.\n[action_chips: "Yes" | "No"]')).toEqual([]);
  });

  it('flags cue overuse', () => {
    expect(kinds('a\n[break]\nb\n[break]\nc\n[break]\nd')).toContain('excess-break-tags');
    expect(kinds('[action_chips: "a"]\n[action_chips: "b"]')).toContain('excess-chip-rows');
  });

  it('flags a fabricated button row', () => {
    // chat.ts forbids this and nothing in production ever checked for it.
    expect(kinds('[Set weather alert] | [Check rain timing]')).toContain(
      'fabricated-interface-element',
    );
  });

  it('does not mistake a markdown table for a button row', () => {
    const table = '| Event | Time |\n| --- | --- |\n| Dentist | 09:00 |';
    expect(kinds(table)).toEqual([]);
  });

  it('flags empty output and stops there', () => {
    expect(kinds('')).toEqual(['empty-output']);
    expect(kinds('   ')).toEqual(['empty-output']);
    expect(kinds(null)).toEqual(['empty-output']);
    expect(kinds(undefined)).toEqual(['empty-output']);
  });

  it('flags a provider-truncated answer', () => {
    expect(kinds('Are you', { finishReason: 'length' })).toContain('truncated-output');
  });

  it('reports truncation alongside emptiness', () => {
    expect(kinds('', { finishReason: 'length' })).toEqual(['truncated-output', 'empty-output']);
  });

  it('flags an emoji unless the owner asked for one', () => {
    expect(kinds('Done 🎉')).toContain('emoji');
    expect(kinds('Done 🎉', { emojiRequested: true })).toEqual([]);
  });

  it('skips the prose checks for structured output', () => {
    // A JSON payload legitimately contains braces, pipes and stray backticks.
    expect(kinds('{"text":"``` [Background notice"}', { structured: true })).toEqual([]);
  });

  it('still reports an empty structured answer', () => {
    expect(kinds('', { structured: true })).toEqual(['empty-output']);
  });

  it('reports provider text that failed structured schema parsing', () => {
    expect(
      kinds(
        '[audit:object-schema-parse-failure] (AI_NoObjectGeneratedError)\n{"date": "not finished',
        { structured: true },
      ),
    ).toEqual(['schema-parse-failure']);
  });

  it('carries a detail a reviewer can act on', () => {
    const [defect] = gradeAuditedOutput('[Set alert] | [Check timing]');
    expect(defect?.detail).toContain('[Set alert]');
  });
});

describe('code-aware marker checks', () => {
  it('does not flag markers the answer is legitimately showing in code', () => {
    // A technical question is exactly where these checks would be worst as
    // false positives: the owner asked how to write a <br>, not for the
    // assistant to emit one.
    const answer = 'Use a line break:\n```html\n<br />\n```\nOr inline: `[/break]`.';
    expect(kinds(answer)).toEqual([]);
  });

  it('still flags the same markers in prose', () => {
    expect(kinds('Done.<br>Next up.')).toContain('leaked-markup');
    expect(kinds('Here you go [smile]')).toContain('leaked-markup');
  });

  it('does not count cue tags inside a code sample toward the cue caps', () => {
    expect(kinds('```\n[break]\n[break]\n[break]\n[break]\n```\nThat is the syntax.')).toEqual([]);
  });
});

describe('repairPresentationDefects', () => {
  it('closes an unclosed fence without touching the content', () => {
    const { text, repairs } = repairPresentationDefects('Here:\n```js\nconsole.log(1);');
    expect(repairs).toEqual(['unclosed-code-fence']);
    expect(text).toBe('Here:\n```js\nconsole.log(1);\n```');
    expect(gradeAuditedOutput(text)).toEqual([]);
  });

  it('strips a forbidden theme tag', () => {
    const { text, repairs } = repairPresentationDefects('[theme: sunset] Your day:');
    expect(repairs).toEqual(['forbidden-theme-tag']);
    expect(text).toBe('Your day:');
  });

  it('leaves a well-formed answer byte-identical', () => {
    const answer = 'Two things today: dentist at 09:00, review at 14:00.';
    const { text, repairs } = repairPresentationDefects(answer);
    expect(text).toBe(answer);
    expect(repairs).toEqual([]);
  });

  it('does not touch defects that need judgement to fix', () => {
    // Removing a bracketed row or an emoji requires knowing what the owner
    // asked for; a wrong rewrite at the last step before delivery is worse
    // than a defect caught in review.
    const answer = '[Set alert] | [Check timing] 🎉';
    expect(repairPresentationDefects(answer).text).toBe(answer);
  });

  it('is idempotent', () => {
    const once = repairPresentationDefects('```js\nx();').text;
    expect(repairPresentationDefects(once).text).toBe(once);
  });
});

describe('wall-of-text', () => {
  const sentence =
    'The quarterly review moved to Thursday because the finance team needs more time.';

  it('flags a plain paragraph that runs past four sentences', () => {
    expect(kinds(Array(5).fill(sentence).join(' '))).toEqual(['wall-of-text']);
  });

  it('passes the same content split into short paragraphs', () => {
    const text = `${[sentence, sentence, sentence].join(' ')}\n\n${[sentence, sentence].join(' ')}`;
    expect(kinds(text)).toEqual([]);
  });

  it('does not count abbreviations or decimals as sentence ends', () => {
    expect(
      kinds('Rain is 3.5 mm, e.g. light. Wind is calm. It is dry by noon. Take a jacket.'),
    ).toEqual([]);
  });

  it('ignores long lists, tables, quotes, and code', () => {
    const long = Array(8).fill(sentence).join(' ');
    expect(kinds(`- ${long}`)).toEqual([]);
    expect(kinds(`| a | b |\n|---|---|\n| ${long} | x |`)).toEqual([]);
    expect(kinds(`> ${long}`)).toEqual([]);
    expect(kinds(`\`\`\`\n${long}\n\`\`\``)).toEqual([]);
  });

  it('measures the prose introduction separately from a long structured list', () => {
    const items = Array.from(
      { length: 8 },
      (_, index) => `- **Category ${index + 1}** — ${sentence.repeat(2)}`,
    ).join('\n');
    expect(kinds(`47 items across 8 categories:\n${items}`)).toEqual([]);
    expect(kinds(`The plan changed because ${sentence.repeat(8)}\n${items}`)).toContain(
      'wall-of-text',
    );
  });

  it('grades serialized tool decisions separately from prose, including old audit rows', () => {
    const args = JSON.stringify({ emoji: '🎉', payload: 'x'.repeat(900) });
    expect(
      kinds(`→ calendar.create_event(${args})`, {
        finishReason: 'tool-calls',
        toolCallsSerialized: true,
      }),
    ).toEqual([]);
    expect(
      kinds(`Checking the calendar now.\n→ calendar.create_event(${args})`, {
        toolCallsSerialized: true,
      }),
    ).toEqual([]);
    expect(
      kinds(`Checking the calendar now.\n→ calendar.create_event(${args.slice(0, 300)}`, {
        toolCallsSerialized: true,
      }),
    ).toEqual([]);
  });
});

describe('repetitive-output', () => {
  it('flags a long repeated fragment', () => {
    expect(kinds('bad-token-'.repeat(30))).toContain('repetitive-output');
    expect(kinds(']">'.repeat(1200))).toContain('repetitive-output');
    expect(kinds('�'.repeat(4))).toContain('repetitive-output');
  });

  it('does not flag ordinary prose or repetitions inside fenced code', () => {
    expect(kinds('The quarterly review moved because the finance team needs more time.')).toEqual(
      [],
    );
    expect(kinds('Very very very very very very very very very very.')).toEqual([]);
    expect(kinds(`\`\`\`text\n${'bad-token-'.repeat(30)}\n\`\`\``)).toEqual([]);
    expect(kinds('bad-token-'.repeat(30), { repetitionRequested: true })).toEqual([]);
  });

  it('flags a malformed C/F unit while accepting other units and directions', () => {
    expect(kinds('The temperature is 12°Chare.')).toContain('malformed-output');
    expect(
      kinds(
        'The temperature is 12°C, 12°Celsius, 54°F, 54°Fahrenheit, 40°North, 40°South, 12°Rankine, and 12°Réaumur.',
      ),
    ).toEqual([]);
  });

  it('recognizes direct owner requests for repeated wording', () => {
    expect(explicitlyRequestsRepetition('Repeat this exactly: ha ha ha')).toBe(true);
    expect(explicitlyRequestsRepetition('Write the word hello 20 times')).toBe(true);
    expect(explicitlyRequestsRepetition('Do not repeat the typo')).toBe(false);
  });
});
