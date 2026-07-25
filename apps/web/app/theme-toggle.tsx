'use client';

import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { focusRing } from '@/lib/ui';

/** Light/dark toggle. The no-flash script in layout.tsx sets the initial class. */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
    // The desktop rail and mobile header each mount their own <ThemeToggle>
    // (one hidden via CSS, not unmounted, depending on breakpoint) — without
    // this, toggling on one leaves the other's icon/label stale until it
    // happens to remount, e.g. resizing across the lg breakpoint mid-session.
    const onExternalChange = () => setDark(document.documentElement.classList.contains('dark'));
    window.addEventListener('app:theme-change', onExternalChange);
    return () => window.removeEventListener('app:theme-change', onExternalChange);
  }, []);

  const toggle = () => {
    const next = !document.documentElement.classList.contains('dark');
    document.documentElement.classList.toggle('dark', next);
    setDark(next);
    window.dispatchEvent(new Event('app:theme-change'));
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light');
    } catch {
      // Private mode or blocked storage — the theme still applies for this
      // session, it just won't be remembered.
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={`mobile-touch-target inline-flex items-center justify-center rounded-md p-1.5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200 motion-safe:transition-[background-color,color,transform] motion-safe:active:scale-90 ${focusRing}`}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
