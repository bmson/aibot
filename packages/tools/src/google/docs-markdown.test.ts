import { describe, expect, it } from 'vitest';
import {
  buildContentRequests,
  type DocsBatchRequest,
  parseInline,
  renderSlideBody,
} from './docs-markdown.js';

function insertedText(requests: DocsBatchRequest[]): string {
  const insert = requests.find((r) => 'insertText' in r)?.insertText as
    | { text?: string }
    | undefined;
  return insert?.text ?? '';
}

function textStyles(requests: DocsBatchRequest[]) {
  return requests
    .filter((r) => 'updateTextStyle' in r)
    .map(
      (r) =>
        r.updateTextStyle as {
          range: { startIndex: number; endIndex: number };
          textStyle: Record<string, unknown>;
          fields: string;
        },
    );
}

describe('parseInline', () => {
  it('splits bold, italic, code, and links into styled runs and strips markers', () => {
    const runs = parseInline('a **b** c *d* `e` [f](https://x.io/p)');
    expect(runs).toEqual([
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: ' c ' },
      { text: 'd', italic: true },
      { text: ' ' },
      { text: 'e', code: true },
      { text: ' ' },
      { text: 'f', link: 'https://x.io/p' },
    ]);
  });

  it('leaves a javascript: link as literal text (only http/https/mailto match)', () => {
    const runs = parseInline('[x](javascript:alert(1))');
    expect(runs).toEqual([{ text: '[x](javascript:alert(1))' }]);
  });

  it('does not mistake a bullet dash or an underscore in a url for emphasis', () => {
    expect(parseInline('plain text')).toEqual([{ text: 'plain text' }]);
    const runs = parseInline('see [docs](https://a.com/foo_bar_baz)');
    expect(runs).toEqual([{ text: 'see ' }, { text: 'docs', link: 'https://a.com/foo_bar_baz' }]);
  });
});

describe('buildContentRequests rich text', () => {
  it('inserts stripped text and styles the bold run over its exact range', () => {
    const { requests } = buildContentRequests('Hello **world**', 1);
    expect(insertedText(requests)).toBe('Hello world');
    expect(textStyles(requests)).toContainEqual({
      range: { startIndex: 7, endIndex: 12 },
      textStyle: { bold: true },
      fields: 'bold',
    });
  });

  it('turns a Markdown link into a real hyperlink run (text only, url hidden)', () => {
    const { requests } = buildContentRequests('see [our plan](https://x.io/p)', 1);
    expect(insertedText(requests)).toBe('see our plan');
    const link = textStyles(requests).find((s) => 'link' in s.textStyle);
    expect(link?.textStyle.link).toEqual({ url: 'https://x.io/p' });
    expect(link?.range).toEqual({ startIndex: 5, endIndex: 13 });
    expect(link?.fields).toContain('link');
  });

  it('renders a numbered list with the ordered preset', () => {
    const { requests } = buildContentRequests('1. first\n2. second', 1);
    expect(insertedText(requests)).toBe('first\nsecond');
    const bullets = requests.find((r) => 'createParagraphBullets' in r)?.createParagraphBullets as {
      range: unknown;
      bulletPreset: string;
    };
    expect(bullets.bulletPreset).toBe('NUMBERED_DECIMAL_ALPHA_ROMAN');
    expect(bullets.range).toEqual({ startIndex: 1, endIndex: 13 });
  });

  it('does not merge an ordered list into an adjacent bullet list', () => {
    const { requests } = buildContentRequests('- a\n1. b', 1);
    const presets = requests
      .filter((r) => 'createParagraphBullets' in r)
      .map((r) => (r.createParagraphBullets as { bulletPreset: string }).bulletPreset);
    expect(presets).toEqual(['BULLET_DISC_CIRCLE_SQUARE', 'NUMBERED_DECIMAL_ALPHA_ROMAN']);
  });

  it('renders a fenced code block as monospace text', () => {
    const { requests } = buildContentRequests('```\ncode()\n```', 1);
    expect(insertedText(requests)).toBe('code()');
    const mono = textStyles(requests).find((s) => 'weightedFontFamily' in s.textStyle);
    expect(mono?.textStyle.weightedFontFamily).toEqual({ fontFamily: 'Courier New' });
  });

  it('renders a Markdown table as bold-header text rows without leftover pipes', () => {
    const { requests } = buildContentRequests('| A | B |\n|---|---|\n| 1 | 2 |', 1);
    const text = insertedText(requests);
    expect(text).toBe('A  •  B\n1  •  2');
    expect(text).not.toContain('|');
    // The header row (first line) is bold.
    expect(textStyles(requests)).toContainEqual({
      range: { startIndex: 1, endIndex: 8 },
      textStyle: { bold: true },
      fields: 'bold',
    });
  });

  it('keeps a plain paragraph as a single unstyled insert (backward compatible)', () => {
    const { requests } = buildContentRequests('First line\nSecond line', 1);
    expect(requests).toEqual([
      { insertText: { location: { index: 1 }, text: 'First line\nSecond line' } },
    ]);
  });
});

describe('renderSlideBody', () => {
  it('strips bullets and returns contiguous bullet ranges plus emphasis spans', () => {
    const rendered = renderSlideBody('- one **bold**\n- two\nplain');
    expect(rendered.text).toBe('one bold\ntwo\nplain');
    expect(rendered.bulletRanges).toEqual([{ start: 0, end: 12 }]);
    expect(rendered.spans).toContainEqual({
      start: 4,
      end: 8,
      bold: true,
      italic: undefined,
      code: undefined,
      link: undefined,
    });
  });
});
