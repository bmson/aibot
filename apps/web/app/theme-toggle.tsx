'use client';

import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { JellyIconButton } from './jelly-icon-button';

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
    document.documentElement.dataset.jellyMode = next ? 'dark' : 'light';
    setDark(next);
    window.dispatchEvent(new CustomEvent('jelly-theme-change'));
    window.dispatchEvent(new Event('app:theme-change'));
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light');
    } catch {
      // Private mode or blocked storage — the theme still applies for this
      // session, it just won't be remembered.
    }
  };

  return (
    <JellyIconButton
      onClick={toggle}
      label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </JellyIconButton>
  );
}
