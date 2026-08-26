import type { UIMessage } from 'ai';

/*
 * Client copy of the companion cue vocabulary.
 *
 * Keep in step with packages/core/src/chat-cues.ts. The boundary rules
 * (scripts/check-boundaries.ts) bar apps/web from importing @assistant/core,
 * so this is a deliberate literal duplicate rather than a shared import.
 * Drift degrades gracefully — an unknown face renders neutral, an unknown
 * theme applies no tint — and the mirrored vocabulary tests on both sides
 * fail together when either list changes.
 */

export const FACE_STATES = [
  'neutral',
  'warm_smile',
  'happy_squint',
  'curious_blink',
  'thoughtful_tilt',
  'wide_excited',
  'gentle_nod',
  'focused',
] as const;
export type FaceState = (typeof FACE_STATES)[number];

export const THEME_NAMES = ['default', 'warm_amber', 'soft_rose', 'cool_sky'] as const;
export type ThemeName = (typeof THEME_NAMES)[number];
export const THEME_LOOKBACK = 8;

export const MAX_CHIPS = 4;
export const MAX_CHIP_LABEL = 60;

type AnyPart = { type: string } & Record<string, unknown>;

function knownFace(value: unknown): FaceState | null {
  return typeof value === 'string' && (FACE_STATES as readonly string[]).includes(value)
    ? (value as FaceState)
    : null;
}

function knownTheme(value: unknown): ThemeName | null {
  return typeof value === 'string' && (THEME_NAMES as readonly string[]).includes(value)
    ? (value as ThemeName)
    : null;
}

/**
 * The newest known face cue on one message — cue parts arrive in stream order
 * (and persist in the same order), so the last one is the expression the reply
 * ended on. Unknown values are skipped, never trusted.
 */
export function faceCueOf(message: UIMessage): FaceState | null {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index] as AnyPart;
    if (part.type !== 'data-face') continue;
    const state = knownFace((part.data as { state?: unknown } | undefined)?.state);
    if (state) return state;
  }
  return null;
}

export function themeCueOf(message: UIMessage): ThemeName | null {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index] as AnyPart;
    if (part.type !== 'data-theme') continue;
    const name = knownTheme((part.data as { name?: unknown } | undefined)?.name);
    if (name) return name;
  }
  return null;
}

/** Quick-reply labels from the newest chips part, re-capped defensively. */
export function chipsOf(message: UIMessage): string[] {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index] as AnyPart;
    if (part.type !== 'data-chips') continue;
    const labels = (part.data as { labels?: unknown } | undefined)?.labels;
    if (!Array.isArray(labels)) continue;
    const clean = labels
      .filter((label): label is string => typeof label === 'string')
      .map((label) => label.trim())
      .filter((label) => label.length > 0 && label.length <= MAX_CHIP_LABEL)
      .slice(0, MAX_CHIPS);
    if (clean.length > 0) return clean;
  }
  return [];
}

/** The newest legacy face cue in the visible log. Kept for old messages. */
export function latestFace(log: UIMessage[]): FaceState {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const message = log[index];
    if (message?.role !== 'assistant') continue;
    const state = faceCueOf(message);
    if (state) return state;
  }
  return 'neutral';
}

/**
 * The chat surface's color mood — pinned to 'default'. The owner asked to
 * keep the mood color unchanged permanently, so this ignores any [theme:]
 * cue in the log (the dashboard persona no longer emits them, but older
 * messages can still carry one) rather than deriving a tint from it.
 */
export function latestTheme(_log: UIMessage[]): ThemeName {
  return 'default';
}
