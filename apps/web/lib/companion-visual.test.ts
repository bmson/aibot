import { beforeEach, describe, expect, it } from 'vitest';
import { FACE_STATES, THEME_NAMES } from './chat-cues';
import {
  type CompanionState,
  getCompanionState,
  resetCompanionState,
  setCompanionState,
  subscribeCompanion,
} from './companion-bus';
import { EXPRESSION_POSES, moodColor, resolveCompanionUniforms } from './companion-visual';

const RESTING: CompanionState = {
  expression: 'neutral',
  mood: 'default',
  activity: 'idle',
  presence: 'idle',
};

beforeEach(() => {
  resetCompanionState();
});

describe('companion bus', () => {
  it('replays the current state to a new subscriber', () => {
    setCompanionState({ expression: 'wide_excited' });
    const seen: CompanionState[] = [];
    subscribeCompanion((state) => seen.push(state));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.expression).toBe('wide_excited');
  });

  it('notifies subscribers on a real change', () => {
    const seen: CompanionState[] = [];
    subscribeCompanion((state) => seen.push(state));
    setCompanionState({ mood: 'warm_amber' });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.mood).toBe('warm_amber');
  });

  it('drops a patch that changes nothing, so easing is never restarted', () => {
    setCompanionState({ activity: 'thinking' });
    const seen: CompanionState[] = [];
    subscribeCompanion((state) => seen.push(state));
    setCompanionState({ activity: 'thinking' });
    setCompanionState({});
    expect(seen).toHaveLength(1);
  });

  it('stops notifying after unsubscribe', () => {
    const seen: CompanionState[] = [];
    const off = subscribeCompanion((state) => seen.push(state));
    off();
    setCompanionState({ expression: 'focused' });
    expect(seen).toHaveLength(1);
    expect(getCompanionState().expression).toBe('focused');
  });

  it('keeps the chat activity and the shell presence independent', () => {
    setCompanionState({ activity: 'speaking' });
    setCompanionState({ presence: 'attention' });
    expect(getCompanionState()).toMatchObject({ activity: 'speaking', presence: 'attention' });
  });
});

describe('resolveCompanionUniforms', () => {
  it('covers every face state with a distinct pose', () => {
    const signatures = new Set(
      FACE_STATES.map((state) => {
        const pose = EXPRESSION_POSES[state];
        return `${pose.openness}|${pose.energy}|${pose.warmth}|${pose.gazeX}|${pose.gazeY}|${pose.bob}`;
      }),
    );
    expect(signatures.size).toBe(FACE_STATES.length);
  });

  it('swings the eyelids across the full expressive range', () => {
    const tilts = FACE_STATES.map((state) => EXPRESSION_POSES[state].lidTilt);
    // The lid angle is the face's main instrument, so it has to reach both
    // ways: inner corners lifted (curious, wistful) and driven down (stern).
    expect(Math.min(...tilts)).toBeLessThan(-0.3);
    expect(Math.max(...tilts)).toBeGreaterThan(0.3);

    const rises = FACE_STATES.map((state) => EXPRESSION_POSES[state].lidRise);
    expect(Math.max(...rises) - Math.min(...rises)).toBeGreaterThan(0.5);

    const openness = FACE_STATES.map((state) => EXPRESSION_POSES[state].openness);
    expect(Math.max(...openness) - Math.min(...openness)).toBeGreaterThan(0.45);
  });

  it('never lets the lids cross, which would erase the eye', () => {
    // Mirrors the shader: the bottom lid only eats into what the top lid left.
    for (const state of FACE_STATES) {
      const { openness, lidRise } = EXPRESSION_POSES[state];
      const topEdge = 2 * openness - 1;
      const botEdge = -1 + lidRise * (topEdge + 1) * 0.82;
      expect(botEdge).toBeLessThan(topEdge);
    }
  });

  it('falls back to the resting pose for an unknown expression', () => {
    const unknown = resolveCompanionUniforms(
      { ...RESTING, expression: 'sarcastic_wink' as never },
      { dark: false },
    );
    expect(unknown).toMatchObject(EXPRESSION_POSES.neutral);
  });

  it('raises energy to the activity floor without lowering a livelier pose', () => {
    const excitedIdle = resolveCompanionUniforms(
      { ...RESTING, expression: 'wide_excited' },
      { dark: false },
    );
    const neutralWorking = resolveCompanionUniforms(
      { ...RESTING, activity: 'working' },
      { dark: false },
    );
    expect(excitedIdle.energy).toBe(1);
    expect(neutralWorking.energy).toBeGreaterThan(EXPRESSION_POSES.neutral.energy);
  });

  it('lets background presence drive energy when the chat is quiet', () => {
    const quiet = resolveCompanionUniforms(RESTING, { dark: false });
    const busyElsewhere = resolveCompanionUniforms(
      { ...RESTING, presence: 'working' },
      { dark: false },
    );
    expect(busyElsewhere.energy).toBeGreaterThan(quiet.energy);
  });

  it('warms up and settles its gaze when something needs the owner', () => {
    const calm = resolveCompanionUniforms(
      { ...RESTING, expression: 'thoughtful_tilt' },
      { dark: false },
    );
    const urgent = resolveCompanionUniforms(
      { ...RESTING, expression: 'thoughtful_tilt', presence: 'attention' },
      { dark: false },
    );
    expect(urgent.warmth).toBeGreaterThan(calm.warmth);
    expect(Math.abs(urgent.gazeX)).toBeLessThan(Math.abs(calm.gazeX));
  });

  it('keeps every uniform inside the range the shader expects', () => {
    for (const expression of FACE_STATES) {
      for (const mood of THEME_NAMES) {
        for (const dark of [false, true]) {
          const u = resolveCompanionUniforms({ ...RESTING, expression, mood }, { dark });
          expect(u.openness).toBeGreaterThanOrEqual(0);
          expect(u.openness).toBeLessThanOrEqual(1);
          expect(u.energy).toBeGreaterThanOrEqual(0);
          expect(u.energy).toBeLessThanOrEqual(1);
          expect(u.warmth).toBeGreaterThanOrEqual(-1);
          expect(u.warmth).toBeLessThanOrEqual(1);
          expect(u.lidTilt).toBeGreaterThanOrEqual(-1);
          expect(u.lidTilt).toBeLessThanOrEqual(1);
          expect(u.lidRise).toBeGreaterThanOrEqual(0);
          expect(u.lidRise).toBeLessThanOrEqual(1);
          expect(u.pupil).toBeGreaterThanOrEqual(0);
          expect(u.pupil).toBeLessThanOrEqual(1);
          expect(u.bob).toBeGreaterThanOrEqual(0);
          expect(u.bob).toBeLessThanOrEqual(1);
          for (const channel of u.color) {
            expect(channel).toBeGreaterThanOrEqual(0);
            expect(channel).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });
});

describe('moodColor', () => {
  it('gives each mood its own colour, lifted in dark mode', () => {
    const light = THEME_NAMES.map((mood) => moodColor(mood, false).join(','));
    expect(new Set(light).size).toBe(THEME_NAMES.length);
    for (const mood of THEME_NAMES) {
      const lit = moodColor(mood, false).reduce((a, b) => a + b, 0);
      const dim = moodColor(mood, true).reduce((a, b) => a + b, 0);
      expect(dim).toBeGreaterThan(lit);
    }
  });

  it('falls back to the default mood for an unknown theme', () => {
    expect(moodColor('neon_void', false)).toEqual(moodColor('default', false));
  });
});
