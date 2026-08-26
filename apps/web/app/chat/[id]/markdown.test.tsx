import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageMarkdown } from './markdown';

describe('MessageMarkdown', () => {
  it('renders common assistant formatting with the restrained type hierarchy', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown
        text={'# Result\n\nThis is **important**, *qualified*, and ~~superseded~~.\n\n- One\n- Two'}
      />,
    );

    expect(html).toContain(
      '<h1 class="mt-6 mb-2 text-lg leading-6 font-semibold text-balance first:mt-0">',
    );
    expect(html).toContain('<strong class="font-semibold ">important</strong>');
    expect(html).toContain('<em class="italic ">qualified</em>');
    expect(html).toContain('<del class="decoration-muted/70 ">superseded</del>');
    expect(html).toContain('<ul class="my-2.5 list-disc');
  });

  it('preserves GFM task-list classes and renders native checkboxes without duplicate bullets', () => {
    const html = renderToStaticMarkup(<MessageMarkdown text={'- [x] Done\n- [ ] Next'} />);

    expect(html).toContain('contains-task-list');
    expect(html).toContain('task-list-item');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('accent-accent');
  });

  it('keeps soft line breaks as real breaks, so one found item per line stays per line', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown
        text={'Found 3 receipts:\nAmazon — $45.99, yesterday\nDelta — flight confirmation'}
      />,
    );

    // The break stays in the DOM as a newline and pre-line renders it;
    // folding it to a space is what produced a single block of text.
    expect(html).toContain('whitespace-pre-line');
    expect(html).toContain('receipts:\nAmazon');
  });

  it('keeps lookup tables compact and scannable', () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown text={'| Item | Count |\n| :--- | ---: |\n| Receipts | 12 |'} />,
    );

    expect(html).toContain('[font-variant-numeric:tabular-nums]');
    expect(html).toContain('align-top');
    expect(html).toContain('Receipts');
  });
});
