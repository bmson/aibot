import type { ReactNode } from 'react';

/**
 * The assistant's face: an initial-based mark that "breathes" while work is
 * running (the design's one signature element). Server-safe — no state; the
 * `active` prop is computed by callers (running tasks on the shell, busy state
 * in chat). Reduced-motion users get the static emerald status dot only.
 */
export function AvatarMark({
  name,
  size = 'md',
  active = false,
  className = '',
}: {
  name: string;
  size?: 'sm' | 'md';
  active?: boolean;
  className?: string;
}) {
  const initial = (name.trim()[0] ?? 'A').toUpperCase();
  const dims = size === 'sm' ? 'size-6 rounded-lg text-xs' : 'size-8 rounded-xl text-sm';
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex shrink-0 items-center justify-center bg-gradient-to-br from-indigo-500 to-indigo-700 font-semibold text-white ${dims} ${
        active ? 'motion-safe:animate-[presence-breathe_2.4s_ease-in-out_infinite]' : ''
      } ${className}`}
    >
      {initial}
      {active ? (
        <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-emerald-400 ring-2 ring-surface" />
      ) : null}
    </span>
  );
}

/** Brand lockup: mark + name, shared by the rail, mobile bar, and chat header. */
export function BrandLockup({
  name,
  active,
  subtitle,
}: {
  name: string;
  active: boolean;
  subtitle?: ReactNode;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2.5">
      <AvatarMark name={name} active={active} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-display text-lg font-semibold tracking-[-0.02em]">
          {name}
        </span>
        {subtitle}
      </span>
    </span>
  );
}
