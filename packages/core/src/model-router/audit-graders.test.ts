import { describe, expect, it } from 'vitest';
import { type AuditDefectKind, gradeAuditedOutput } from './audit-graders.js';

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

  it('carries a detail a reviewer can act on', () => {
    const [defect] = gradeAuditedOutput('[Set alert] | [Check timing]');
    expect(defect?.detail).toContain('[Set alert]');
  });
});
