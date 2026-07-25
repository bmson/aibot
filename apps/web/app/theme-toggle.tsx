'use client';

import { Moon, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { focusRing } from '@/lib/ui';

/** Light/dark toggle. The no-flash script in layout.tsx sets the initial class. */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Guards against a second tap landing mid-wipe. Touchscreens have no hover
  // state to signal "this already registered", so a second tap before the
  // first ripple finishes is common — and a second startViewTransition() call
  // races the first for the DOM snapshot, which Chrome resolves by aborting it
  // (`ready` rejects with InvalidStateError), freezing the ripple wherever it
  // had grown to and snapping straight to the second click's result. Ignoring
  // repeat taps until the current wipe settles keeps every wipe uninterrupted.
  const wiping = useRef(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
  }, []);

  const toggle = () => {
    if (wiping.current) return;
    const next = !document.documentElement.classList.contains('dark');

    const apply = () => {
      document.documentElement.classList.toggle('dark', next);
      setDark(next);
    };

    const persist = () => {
      try {
        localStorage.setItem('theme', next ? 'dark' : 'light');
      } catch {
        // Private mode or blocked storage — the theme still applies for this
        // session, it just won't be remembered.
      }
    };

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Flipping the class is synchronous, which is exactly what the View
    // Transition API wants: the browser snapshots the old theme, we swap, it
    // snapshots the new one, and we animate between the two. Anything that
    // can't do that (no support, reduced motion) just swaps instantly.
    if (reduceMotion || typeof document.startViewTransition !== 'function') {
      apply();
      persist();
      return;
    }

    wiping.current = true;
    const transition = document.startViewTransition(apply);
    persist();

    // If the tab loses focus or visibility mid-wipe, its rAF-driven animation
    // can stall without ever reaching `finished` — the old/new snapshot pair
    // is left composited on top of the (already-correct) real page, frozen
    // wherever the circle stopped growing. Force the transition to finish
    // once comfortably past its own 520ms so it can never hang there; this
    // never fires on the normal path, since `finished` resolves first.
    const unstick = window.setTimeout(() => transition.skipTransition(), 1000);
    transition.finished.finally(() => {
      window.clearTimeout(unstick);
      wiping.current = false;
    });

    transition.ready
      .then(() => {
        // Grow a circle from the toggle itself, sized to reach the furthest
        // corner of the viewport so the new theme fully covers the old one.
        const button = buttonRef.current;
        if (!button) return;
        const { top, left, width, height } = button.getBoundingClientRect();
        const x = left + width / 2;
        const y = top + height / 2;
        const radius = Math.hypot(
          Math.max(x, window.innerWidth - x),
          Math.max(y, window.innerHeight - y),
        );

        document.documentElement.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
          {
            duration: 520,
            // A steep ease-out (the previous 0.22,1,0.36,1) front-loads nearly
            // all the growth: by the temporal midpoint the circle is already
            // ~96% of its final radius, so the back half of the animation is
            // visually static — it reads as "stops halfway", and the eventual
            // pseudo-element teardown then looks like a snap. This symmetric
            // ease-in-out keeps the radius visibly growing for the full 520ms
            // (half the growth at the temporal half), which also spreads the
            // per-frame repaint cost evenly instead of bursting it into the
            // first ~250ms — the part a weaker mobile GPU tends to drop.
            easing: 'cubic-bezier(0.65, 0, 0.35, 1)',
            pseudoElement: '::view-transition-new(root)',
          },
        );
      })
      .catch(() => {
        // `ready` rejects whenever the browser declines the transition — the
        // document is hidden, or a second toggle aborted this one. The theme
        // itself has already been applied by `apply()`, so there is nothing to
        // recover: we just skip the flourish. Without this handler that
        // rejection surfaces as an unhandled promise error.
      });
  };

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={toggle}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={`mobile-touch-target inline-flex items-center justify-center rounded-md p-1.5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200 motion-safe:transition-[background-color,color,transform] motion-safe:active:scale-90 ${focusRing}`}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
