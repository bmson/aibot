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

    expect(html).toContain('<h1 class="mt-6 mb-2 text-lg leading-6 font-semibold first:mt-0">');
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
});
