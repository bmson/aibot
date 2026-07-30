import type { ReactNode } from 'react';

/**
 * Remounts on navigation so each route enters as one spatial surface. The
 * motion system owns the animation and disables it for reduced-motion users.
 */
export default function Template({ children }: { children: ReactNode }) {
  return <div className="route-surface">{children}</div>;
}
