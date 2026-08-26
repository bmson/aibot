import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CompanionFace } from './companion-face';

describe('CompanionFace', () => {
  it('renders two eyes and stays out of the accessibility tree', () => {
    const html = renderToStaticMarkup(<CompanionFace face="neutral" />);
    expect(html).toContain('aria-hidden="true"');
    // Two eye spans with the resting geometry (5.5 × 7, as on iOS).
    expect(html.match(/width:5\.5px;height:7px/g)).toHaveLength(2);
  });

  it('squints both eyes on a warm smile', () => {
    const html = renderToStaticMarkup(<CompanionFace face="warm_smile" />);
    expect(html.match(/height:2px/g)).toHaveLength(2);
  });

  it('blinks only one eye on a curious blink', () => {
    const html = renderToStaticMarkup(<CompanionFace face="curious_blink" />);
    expect(html.match(/height:7px/g)).toHaveLength(1);
    expect(html.match(/height:2px/g)).toHaveLength(1);
  });

  it('tilts on a thoughtful tilt', () => {
    expect(renderToStaticMarkup(<CompanionFace face="thoughtful_tilt" />)).toContain(
      'rotate(-8deg)',
    );
  });
});
