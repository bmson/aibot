import type { ReactNode } from 'react';

/**
 * Remounts on every navigation, so each page arrives with one soft rise-in.
 * Purely decorative: behind motion-safe, reduced-motion readers get an
 * instant swap, and the wrapper adds no layout of its own.
 */
export default function Template({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-0 motion-safe:animate-[page-in_260ms_cubic-bezier(0.22,1,0.36,1)_both]">
      {children}
    </div>
  );
}
