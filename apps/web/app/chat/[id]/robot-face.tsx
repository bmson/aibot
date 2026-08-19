'use client';

import { FACE_STATES, type FaceState } from '@/lib/chat-cues';

/**
 * The companion's face: one inline SVG character (CSP-safe, like the
 * hand-drawn flourish in chat-client) whose expressions are pure CSS keyed off
 * `data-face-state` — see the "Companion robot face" block in globals.css.
 * Poses are static attribute/opacity swaps so every expression change is
 * visible under reduced motion; the blinking, nodding, and pop flourishes all
 * sit behind the reduced-motion media query. Colors read the theme tokens
 * (`--accent`, `--surface-sunken`), so a `[theme:]` re-tint and dark mode both
 * reach the face for free.
 */
export function RobotFace({
  state,
  busy = false,
  className = '',
}: {
  state: string;
  busy?: boolean;
  className?: string;
}) {
  const known: FaceState = (FACE_STATES as readonly string[]).includes(state)
    ? (state as FaceState)
    : 'neutral';
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      data-face-state={known}
      data-busy={busy || undefined}
      className={`rf ${className}`}
    >
      <g className="rf-head">
        <circle className="rf-antenna" cx="24" cy="4.5" r="2" />
        <line className="rf-antenna-stem" x1="24" y1="6.5" x2="24" y2="9.5" />
        <rect className="rf-shell" x="6" y="9" width="36" height="31" rx="12" />
        <rect className="rf-visor" x="10.5" y="15.5" width="27" height="13" rx="6.5" />
        <g className="rf-eyes">
          <g className="rf-eye rf-eye-l">
            <rect className="rf-eye-dot" x="15.4" y="17.5" width="4.8" height="9" rx="2.4" />
            <path className="rf-eye-arc" d="M 14.8 23.5 Q 17.8 19.5 20.8 23.5" />
          </g>
          <g className="rf-eye rf-eye-r">
            <rect className="rf-eye-dot" x="27.8" y="17.5" width="4.8" height="9" rx="2.4" />
            <path className="rf-eye-arc" d="M 27.2 23.5 Q 30.2 19.5 33.2 23.5" />
          </g>
        </g>
        {/* All mouth variants render; the active state fades exactly one in. */}
        <g className="rf-mouths">
          <path className="rf-mouth rf-mouth-soft" d="M 20.5 33 Q 24 34.5 27.5 33" />
          <path className="rf-mouth rf-mouth-smile" d="M 19 32 Q 24 36.5 29 32" />
          <path className="rf-mouth rf-mouth-flat" d="M 20.5 33.5 L 27.5 33.5" />
          <path className="rf-mouth rf-mouth-small" d="M 22 33.5 L 26 33.5" />
          <ellipse className="rf-mouth rf-mouth-open" cx="24" cy="33.5" rx="3.2" ry="3.9" />
        </g>
      </g>
    </svg>
  );
}
