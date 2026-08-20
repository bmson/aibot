'use client';

import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import {
  type CompanionState,
  getCompanionState,
  type CompanionPresence as Presence,
  setCompanionState,
  subscribeCompanion,
  subscribeCompanionWake,
} from '@/lib/companion-bus';
import { resolveCompanionUniforms } from '@/lib/companion-visual';

/*
 * The companion, living in the notch.
 *
 * A dark housing hangs from the top center of the screen — on a notched phone
 * it reads as the hardware notch itself grown a little, on any other screen as
 * a small island the app keeps for its creature. A pair of expressive eyes
 * lives inside. Most of the time they are tucked away above the screen edge;
 * when a message goes out or lands, the housing pops down, the eyes look at
 * you, feel something about the moment, and withdraw again.
 *
 * All of the character comes from lib/companion-visual.ts: the same eyelid
 * poses that once drove the WebGL lenses now drive plain CSS — openness, lid
 * angle, the bottom-lid smile — published as custom properties the stylesheet
 * eases between (notch.css). This component only decides WHEN the eyes are
 * out; everything about how they move is CSS, so reduced-motion support is one
 * media query rather than a second animation system.
 */

/** How long a message pulse keeps the eyes out — long enough to be met. */
const WAKE_HOLD_MS = 4200;
/** After a busy spell ends, hold the final expression before tucking away. */
const SETTLE_HOLD_MS = 3200;
/** The greeting: one brief peek when the app opens, so the creature is met. */
const HELLO_HOLD_MS = 2600;
/** One blink, lids down and back. */
const BLINK_MS = 150;

/** While any of these hold, the eyes stay out rather than merely visiting. */
const BUSY_ACTIVITIES = new Set(['thinking', 'speaking', 'working', 'attention']);

function isBusy(state: CompanionState): boolean {
  return BUSY_ACTIVITIES.has(state.activity) || state.presence !== 'idle';
}

export function NotchCompanion({ presence }: { presence: Presence }) {
  // Publish the server's baseline. Its own effect so a navigation that changes
  // the shell's presence updates the creature without remounting the housing.
  useEffect(() => {
    setCompanionState({ presence });
  }, [presence]);

  const [state, setState] = useState<CompanionState>(getCompanionState);
  // A wall-clock deadline, not a boolean: overlapping pulses (a send followed
  // by the reply) just push the same deadline out instead of fighting.
  const [holdUntil, setHoldUntil] = useState(0);
  const [peeking, setPeeking] = useState(false);
  const [blink, setBlink] = useState(false);

  useEffect(() => subscribeCompanion(setState), []);
  useEffect(() => subscribeCompanionWake(() => setHoldUntil(Date.now() + WAKE_HOLD_MS)), []);

  // Say hello once per full load. In an effect, so the server renders the
  // housing tucked and the greeting is a real movement rather than a
  // hydration mismatch.
  useEffect(() => {
    setHoldUntil(Date.now() + HELLO_HOLD_MS);
  }, []);

  const busy = isBusy(state);

  // Ending a busy spell earns its own hold: the reply's final expression is
  // the payoff, and tucking away on the same frame it lands would swallow it.
  const wasBusyRef = useRef(false);
  useEffect(() => {
    if (wasBusyRef.current && !busy) {
      setHoldUntil((until) => Math.max(until, Date.now() + SETTLE_HOLD_MS));
    }
    wasBusyRef.current = busy;
  }, [busy]);

  // Out while busy or held; otherwise schedule the tuck for when the hold ends.
  useEffect(() => {
    const remaining = holdUntil - Date.now();
    if (busy || remaining > 0) {
      setPeeking(true);
      if (busy) return;
      const timer = window.setTimeout(() => setPeeking(false), remaining);
      return () => window.clearTimeout(timer);
    }
    setPeeking(false);
  }, [busy, holdUntil]);

  // Blink now and then while out. A timer chain rather than an interval so the
  // rhythm can wander the way a real blink does, and quicken with energy.
  const energy = useMemo(() => resolveCompanionUniforms(state, { dark: true }).energy, [state]);
  useEffect(() => {
    if (!peeking) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let closeTimer = 0;
    let openTimer = 0;
    let disposed = false;
    const schedule = () => {
      const wait = (2400 - energy * 900) * (0.7 + Math.random() * 0.9);
      closeTimer = window.setTimeout(() => {
        if (disposed) return;
        setBlink(true);
        openTimer = window.setTimeout(() => {
          if (disposed) return;
          setBlink(false);
          schedule();
        }, BLINK_MS);
      }, wait);
    };
    schedule();
    return () => {
      disposed = true;
      window.clearTimeout(closeTimer);
      window.clearTimeout(openTimer);
      setBlink(false);
    };
  }, [peeking, energy]);

  // The pose, as custom properties for notch.css to ease between. The housing
  // is night-colored in both app themes, so the mood glow always uses the
  // lifted dark-mode tints — that is what `dark: true` selects.
  const pose = useMemo(() => resolveCompanionUniforms(state, { dark: true }), [state]);
  const style = {
    '--eye-open': pose.openness,
    '--eye-tilt': pose.lidTilt,
    '--eye-rise': pose.lidRise,
    '--gaze-x': pose.gazeX,
    '--gaze-y': pose.gazeY,
    '--bob': pose.bob,
    '--energy': pose.energy,
    '--notch-glow': `rgb(${pose.color.map((c) => Math.round(c * 255)).join(' ')})`,
  } as CSSProperties;

  // Decoration only, and click-through: the chat still states its status in
  // words, so there is nothing here for a screen reader or a pointer.
  return (
    <div
      aria-hidden="true"
      className="notch-companion"
      data-peek={peeking}
      data-blink={blink}
      style={style}
    >
      <div className="notch-face">
        <span className="notch-glow" />
        <span className="notch-eyes">
          <span className="notch-eye" data-side="left">
            <span className="notch-eye-cheek" />
          </span>
          <span className="notch-eye" data-side="right">
            <span className="notch-eye-cheek" />
          </span>
        </span>
      </div>
    </div>
  );
}
