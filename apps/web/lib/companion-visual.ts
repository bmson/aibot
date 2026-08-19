import { FACE_STATES, type FaceState, THEME_NAMES, type ThemeName } from './chat-cues';
import type { CompanionActivity, CompanionPresence, CompanionState } from './companion-bus';

/*
 * How a cue becomes a face.
 *
 * The companion is a pair of lenses, WALL·E style, and almost all of its
 * feeling lives in the eyelids: how far the top lid comes down, how far the
 * bottom lid pushes up, and — above all — the angle the lids are set at.
 * Inner corners lifted reads as curious or wistful; inner corners driven down
 * reads as determined. That one line is doing more work than any amount of
 * detail inside the eye, which is why the eyes themselves stay plain.
 *
 * Pure data + arithmetic, kept out of the WebGL component so the character's
 * behavior is unit-testable without a GL context. The presence layer eases
 * toward whatever this returns; nothing here knows about time.
 */

export interface CompanionUniforms {
  /** Lid aperture, 0 = shut, 1 = wide open. */
  openness: number;
  /**
   * Lid angle, -1 .. 1. Negative lifts the inner corners (curious, wistful);
   * positive drives them down (determined, stern). Mirrored across the eyes.
   */
  lidTilt: number;
  /** Bottom lid push, 0 = flat, 1 = a full squeeze — this is the smile. */
  lidRise: number;
  /** Pupil size relative to the lens, 0 = pinpoint, 1 = blown wide. */
  pupil: number;
  /** Motion and glow, 0 = nearly still, 1 = alive and racing. */
  energy: number;
  /** Hue lean, -1 = cool and analytic, +1 = warm and affectionate. */
  warmth: number;
  /** Where it is looking, roughly -1..1. */
  gazeX: number;
  gazeY: number;
  /** Vertical rocking amplitude — the nod. */
  bob: number;
  /** Body color in 0..1 RGB, from the mood and the active theme. */
  color: [number, number, number];
}

type Pose = Omit<CompanionUniforms, 'color'>;

/** Resting pose; every expression below is a departure from this. */
const NEUTRAL: Pose = {
  openness: 0.84,
  lidTilt: 0,
  lidRise: 0.04,
  pupil: 0.5,
  energy: 0.26,
  warmth: 0,
  gazeX: 0,
  gazeY: 0,
  bob: 0,
};

export const EXPRESSION_POSES: Record<FaceState, Pose> = {
  neutral: NEUTRAL,
  // Lids ease down a touch and the lower lids lift: eyes that are smiling.
  warm_smile: {
    openness: 0.72,
    lidTilt: -0.08,
    lidRise: 0.26,
    pupil: 0.55,
    energy: 0.42,
    warmth: 0.45,
    gazeX: 0,
    gazeY: 0.04,
    bob: 0.16,
  },
  // The full delighted squeeze — bottom lids up, eyes nearly crescents.
  happy_squint: {
    openness: 0.5,
    lidTilt: -0.1,
    lidRise: 0.62,
    pupil: 0.6,
    energy: 0.68,
    warmth: 0.7,
    gazeX: 0,
    gazeY: 0.06,
    bob: 0.34,
  },
  // Inner corners lifted and eyes flung open: the questioning look.
  curious_blink: {
    openness: 1,
    lidTilt: -0.34,
    lidRise: 0,
    pupil: 0.68,
    energy: 0.54,
    warmth: 0.12,
    gazeX: 0.22,
    gazeY: 0.12,
    bob: 0.1,
  },
  // Lids tilt hard, gaze wanders up and away, everything slows.
  thoughtful_tilt: {
    openness: 0.66,
    lidTilt: -0.44,
    lidRise: 0.08,
    pupil: 0.42,
    energy: 0.3,
    warmth: -0.3,
    gazeX: -0.3,
    gazeY: 0.22,
    bob: 0,
  },
  // Everything open, pupils blown, lids out of the way entirely.
  wide_excited: {
    openness: 1,
    lidTilt: -0.05,
    lidRise: 0,
    pupil: 0.92,
    energy: 1,
    warmth: 0.55,
    gazeX: 0,
    gazeY: 0.02,
    bob: 0.5,
  },
  // Agreement, carried by the rocking more than the face.
  gentle_nod: {
    openness: 0.78,
    lidTilt: -0.06,
    lidRise: 0.2,
    pupil: 0.54,
    energy: 0.46,
    warmth: 0.3,
    gazeX: 0,
    gazeY: -0.06,
    bob: 0.9,
  },
  // Inner corners driven down and pupils tightened: the determined squint.
  focused: {
    openness: 0.46,
    lidTilt: 0.36,
    lidRise: 0.12,
    pupil: 0.3,
    energy: 0.74,
    warmth: -0.42,
    gazeX: 0,
    gazeY: 0,
    bob: 0,
  },
};

/** Floor on energy per activity — what it is doing outranks how it feels. */
const ACTIVITY_ENERGY: Record<CompanionActivity, number> = {
  idle: 0,
  listening: 0.3,
  thinking: 0.5,
  speaking: 0.58,
  working: 0.72,
  attention: 0.88,
};

/** The same floor for the server-side baseline, so background work still shows. */
const PRESENCE_ENERGY: Record<CompanionPresence, number> = {
  idle: 0,
  working: 0.6,
  attention: 0.88,
};

/** Mood palettes, mirroring the [theme:] cue names. Light theme, then dark. */
const MOOD_COLORS: Record<
  ThemeName,
  { light: [number, number, number]; dark: [number, number, number] }
> = {
  default: { light: [0.13, 0.4, 0.43], dark: [0.45, 0.72, 0.74] },
  warm_amber: { light: [0.63, 0.38, 0.02], dark: [0.87, 0.66, 0.38] },
  soft_rose: { light: [0.66, 0.29, 0.45], dark: [0.89, 0.61, 0.73] },
  cool_sky: { light: [0.06, 0.41, 0.65], dark: [0.49, 0.76, 0.92] },
};

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function moodColor(mood: string, dark: boolean): [number, number, number] {
  const known = (THEME_NAMES as readonly string[]).includes(mood) ? (mood as ThemeName) : 'default';
  const entry = MOOD_COLORS[known];
  return dark ? entry.dark : entry.light;
}

/**
 * Resolve a published state into the uniforms the shader animates toward.
 * Unknown values fall back to the resting pose and the default mood, so a
 * vocabulary drift between server and client degrades instead of breaking.
 */
export function resolveCompanionUniforms(
  state: CompanionState,
  options: { dark: boolean },
): CompanionUniforms {
  const known = (FACE_STATES as readonly string[]).includes(state.expression)
    ? state.expression
    : 'neutral';
  const pose = EXPRESSION_POSES[known] ?? NEUTRAL;
  // Whichever is more demanding wins: a chat turn in this tab, or work the
  // rest of the system is doing.
  const floor = Math.max(
    ACTIVITY_ENERGY[state.activity] ?? 0,
    PRESENCE_ENERGY[state.presence] ?? 0,
  );
  // Working states also pull the gaze back to center: a busy companion is
  // looking at the work, not wandering.
  const settle = floor >= ACTIVITY_ENERGY.working ? 0.45 : 1;
  const wantsAttention = state.activity === 'attention' || state.presence === 'attention';
  return {
    openness: clamp01(pose.openness),
    lidTilt: Math.max(-1, Math.min(1, pose.lidTilt)),
    lidRise: clamp01(pose.lidRise),
    pupil: clamp01(pose.pupil),
    energy: clamp01(Math.max(pose.energy, floor)),
    warmth: Math.max(-1, Math.min(1, wantsAttention ? pose.warmth + 0.35 : pose.warmth)),
    gazeX: pose.gazeX * settle,
    gazeY: pose.gazeY * settle,
    bob: clamp01(pose.bob),
    color: moodColor(state.mood, options.dark),
  };
}
