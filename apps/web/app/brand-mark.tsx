import type { ReactNode } from 'react';

export type AssistantPresence = 'idle' | 'working' | 'attention';

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
  presence,
  className = '',
}: {
  name: string;
  size?: 'sm' | 'md';
  active?: boolean;
  presence?: AssistantPresence;
  className?: string;
}) {
  const initial = (name.trim()[0] ?? 'A').toUpperCase();
  const dims = size === 'sm' ? 'size-6 rounded-lg text-xs' : 'size-8 rounded-xl text-sm';
  const state = presence ?? (active ? 'working' : 'idle');
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex shrink-0 items-center justify-center bg-gradient-to-br from-accent to-accent-hover font-semibold text-white ${dims} ${
        state === 'working' ? 'motion-safe:animate-[presence-breathe_2.4s_ease-in-out_3]' : ''
      } ${className}`}
    >
      {initial}
      {state !== 'idle' ? (
        // The mark sits on the nav rail (a raised panel like any other box),
        // so the dot's cut-out ring matches that surface, not the canvas
        // behind it — ring-surface read as a pale halo against a panel.
        <span
          className={`absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-raised ${
            state === 'attention' ? 'bg-amber-400' : 'bg-emerald-400'
          }`}
        />
      ) : null}
    </span>
  );
}

/** Brand lockup: mark + name, shared by the rail, mobile bar, and chat header. */
export function BrandLockup({
  name,
  presence,
  subtitle,
}: {
  name: string;
  presence: AssistantPresence;
  subtitle?: ReactNode;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2.5">
      <AvatarMark name={name} presence={presence} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-display text-lg font-semibold tracking-[-0.02em]">
          {name}
        </span>
        {subtitle}
      </span>
    </span>
  );
}
