import type { ReactNode } from 'react';

// Shared UI primitives: the one place button/badge/card/section styling
// lives. Class-string constants (not components) where client components
// need to compose them with their own handlers.

/** Visible keyboard-focus ring shared by buttons, links, and menu items. */
export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-surface';

const btnBase = `mobile-touch-target inline-flex items-center justify-center gap-1.5 font-medium motion-safe:transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
const btnMd = 'rounded-lg px-3 py-1.5 text-sm';
const btnXs = 'rounded-md px-2.5 py-1 text-xs';

const btnVariants = {
  outline:
    'border border-edge text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
  dangerOutline:
    'border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40',
  primary: 'bg-accent text-white shadow-sm hover:bg-accent-hover',
  danger: 'bg-red-600 text-white hover:bg-red-700',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700',
} as const;

/** Default button scale — comfortable for primary actions and card controls. */
export const btn = {
  outline: `${btnBase} ${btnMd} ${btnVariants.outline}`,
  dangerOutline: `${btnBase} ${btnMd} ${btnVariants.dangerOutline}`,
  primary: `${btnBase} ${btnMd} ${btnVariants.primary}`,
  danger: `${btnBase} ${btnMd} ${btnVariants.danger}`,
  success: `${btnBase} ${btnMd} ${btnVariants.success}`,
} as const;

/** Dense scale for table rows and per-item micro-actions (old default size). */
export const btnSm = {
  outline: `${btnBase} ${btnXs} ${btnVariants.outline}`,
  dangerOutline: `${btnBase} ${btnXs} ${btnVariants.dangerOutline}`,
  primary: `${btnBase} ${btnXs} ${btnVariants.primary}`,
  danger: `${btnBase} ${btnXs} ${btnVariants.danger}`,
  success: `${btnBase} ${btnXs} ${btnVariants.success}`,
} as const;

/** Zinc count-pill as a raw class string, for spans that can't use <CountBadge>. */
export const countBadgeClass =
  'rounded-full bg-zinc-100 px-1.5 py-0.5 text-2xs font-medium text-zinc-600 whitespace-nowrap dark:bg-zinc-800 dark:text-zinc-400';

/** A loading placeholder block — used by route-level loading.tsx skeletons. */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div className={`animate-pulse rounded-md bg-zinc-200/70 dark:bg-zinc-800/70 ${className}`} />
  );
}

export const inputClass =
  'rounded-lg border border-edge bg-raised px-2.5 py-1.5 text-base outline-none motion-safe:transition-shadow focus:border-accent focus:ring-2 focus:ring-accent/20 sm:text-sm';

export const labelClass = 'text-xs font-medium text-zinc-600 dark:text-zinc-400';

/** Collapsible-section summary row (native <details>). */
export const summaryClass =
  'flex cursor-pointer list-none items-baseline gap-2 text-sm font-medium [&::-webkit-details-marker]:hidden';

export function PageHeader({ title, intro }: { title: string; intro?: ReactNode }) {
  return (
    <header>
      <h1 className="font-display text-2xl font-semibold tracking-[-0.02em] text-strong">
        {title}
      </h1>
      {intro ? <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{intro}</p> : null}
    </header>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-edge bg-raised p-4 shadow-sm ${className}`}>
      {children}
    </div>
  );
}

const badgeTones = {
  zinc: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
} as const;

export function CountBadge({
  children,
  tone = 'zinc',
}: {
  children: ReactNode;
  tone?: keyof typeof badgeTones;
}) {
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 text-2xs font-semibold whitespace-nowrap ${badgeTones[tone]}`}
    >
      {children}
    </span>
  );
}

export function SectionHeading({
  title,
  count,
  hint,
}: {
  title: string;
  count?: number;
  hint?: string;
}) {
  return (
    <h2 className="flex min-w-0 flex-wrap items-baseline gap-2 text-sm font-medium">
      {title}
      {count !== undefined ? <CountBadge>{count}</CountBadge> : null}
      {hint ? <span className="text-xs font-normal text-muted">{hint}</span> : null}
    </h2>
  );
}

export function EmptyState({
  children,
  icon,
  action,
}: {
  children: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  if (!icon && !action) return <p className="mt-3 text-sm text-muted">{children}</p>;
  return (
    <div className="mt-3 flex flex-col items-start gap-2 rounded-xl border border-dashed border-edge px-4 py-5">
      {icon ? (
        <span aria-hidden="true" className="text-muted">
          {icon}
        </span>
      ) : null}
      <p className="text-sm leading-6 text-muted">{children}</p>
      {action}
    </div>
  );
}
