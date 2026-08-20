import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActionChips } from './action-chips';

describe('ActionChips', () => {
  it('renders one pill per label', () => {
    const html = renderToStaticMarkup(
      <ActionChips labels={['Go with Option A', 'Show Option B']} active onSend={() => {}} />,
    );
    expect(html).toContain('Go with Option A');
    expect(html).toContain('Show Option B');
    expect(html).not.toContain('disabled=""');
  });

  it('fades and disables once the conversation has moved on', () => {
    const html = renderToStaticMarkup(
      <ActionChips labels={['Stale option']} active={false} onSend={() => {}} />,
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain('opacity-50');
  });

  it('renders nothing without labels', () => {
    expect(renderToStaticMarkup(<ActionChips labels={[]} active onSend={() => {}} />)).toBe('');
  });
});
