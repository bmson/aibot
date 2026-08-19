import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FACE_STATES } from '@/lib/chat-cues';
import { ActionChips } from './action-chips';
import { RobotFace } from './robot-face';

describe('RobotFace', () => {
  it('stamps each known state on the svg for the CSS poses to key off', () => {
    for (const state of FACE_STATES) {
      const html = renderToStaticMarkup(<RobotFace state={state} />);
      expect(html).toContain(`data-face-state="${state}"`);
    }
  });

  it('falls back to neutral for an unknown state', () => {
    const html = renderToStaticMarkup(<RobotFace state="sarcastic_wink" />);
    expect(html).toContain('data-face-state="neutral"');
  });

  it('marks busy for the visor glow and stays decorative to screen readers', () => {
    const busy = renderToStaticMarkup(<RobotFace state="focused" busy />);
    expect(busy).toContain('data-busy="true"');
    expect(busy).toContain('aria-hidden="true"');
    const idle = renderToStaticMarkup(<RobotFace state="neutral" />);
    expect(idle).not.toContain('data-busy');
  });

  it('renders every expression variant so poses are pure CSS swaps', () => {
    const html = renderToStaticMarkup(<RobotFace state="neutral" />);
    for (const variant of [
      'rf-eye-dot',
      'rf-eye-arc',
      'rf-mouth-soft',
      'rf-mouth-smile',
      'rf-mouth-open',
    ]) {
      expect(html).toContain(variant);
    }
  });
});

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
