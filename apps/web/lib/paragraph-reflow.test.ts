import { describe, expect, it } from 'vitest';
import { reflowParagraphs } from './paragraph-reflow';
import fixtures from './paragraph-reflow.fixtures.json';

// The same fixtures drive AssistantMarkdownTests on iOS, so both clients split
// a reply at the same places.
describe('reflowParagraphs', () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      expect(reflowParagraphs(fixture.input)).toBe(fixture.expected);
    });
    it(`${fixture.name} (idempotent)`, () => {
      expect(reflowParagraphs(fixture.expected)).toBe(fixture.expected);
    });
  }

  it('changes nothing but whitespace', () => {
    for (const { input, expected } of fixtures)
      expect(expected.replace(/\s+/g, ' ')).toBe(input.replace(/\s+/g, ' '));
  });
});
