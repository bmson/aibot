'use client';

import { useEffect, useState } from 'react';
import type { FaceState } from '@/lib/chat-cues';

/*
 * The companion's face on the dashboard — a faithful port of the iOS
 * CompanionCapsule's two-eye face. The geometry carries the expression
 * (squint, width, tilt, a one-eyed blink), and a 3.8s blink keeps it alive
 * without ever moving while the owner reads (reduce-motion drops the timer).
 *
 * Purely expressive, so it is aria-hidden: activity is announced by the
 * notch, and the words carry the meaning.
 */

/** Per-face eye geometry, mirroring CompanionCapsule.swift exactly. */
function eyeStyle(face: FaceState, blinking: boolean, right: boolean) {
  const squint =
    blinking ||
    face === 'happy_squint' ||
    face === 'warm_smile' ||
    (right && face === 'curious_blink');
  return {
    width: face === 'wide_excited' ? 6.5 : 5.5,
    height: squint ? 2 : face === 'focused' ? 5.5 : 7,
  };
}

const BLINK_EVERY_MS = 3800;
const BLINK_HOLD_MS = 130;

export function CompanionFace({ face }: { face: FaceState }) {
  const [blinking, setBlinking] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let hold: ReturnType<typeof setTimeout> | undefined;
    const timer = setInterval(() => {
      setBlinking(true);
      hold = setTimeout(() => setBlinking(false), BLINK_HOLD_MS);
    }, BLINK_EVERY_MS);
    return () => {
      clearInterval(timer);
      if (hold) clearTimeout(hold);
    };
  }, []);

  const left = eyeStyle(face, blinking, false);
  const right = eyeStyle(face, blinking, true);

  return (
    <span
      aria-hidden="true"
      className="pointer-events-none relative inline-flex items-center justify-center overflow-hidden rounded-full bg-black px-3 py-2 dark:bg-neutral-900"
    >
      {/* The housing's top sheen, as on the iOS capsule. */}
      <span className="absolute inset-x-2 top-0 h-px rounded-full bg-white/10" />
      <span
        className="flex items-center transition-transform duration-150 ease-in-out"
        style={{
          gap: face === 'wide_excited' ? 7 : 6,
          transform: `${face === 'thoughtful_tilt' ? 'rotate(-8deg) ' : ''}translateY(${face === 'gentle_nod' ? 1 : 0}px)`,
        }}
      >
        {[left, right].map((eye, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: two static eyes, order never changes
            key={index}
            className="rounded-full bg-[#E7F2EA] transition-all duration-120 ease-in-out"
            style={{ width: eye.width, height: eye.height }}
          />
        ))}
      </span>
    </span>
  );
}
