import type { ReactNode } from 'react';

// Shared UI primitives: the one place button/badge/card/section styling
// lives. Class-string constants (not components) where client components
// need to compose them with their own handlers.

export const btn = {
  outline:
    'mobile-touch-target inline-flex items-center justify-center rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800',
  dangerOutline:
    'mobile-touch-target inline-flex items-center justify-center rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40',
  primary:
    'mobile-touch-target inline-flex items-center justify-center rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50',
  danger:
    'mobile-touch-target inline-flex items-center justify-center rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50',
  success:
    'mobile-touch-target inline-flex items-center justify-center rounded-md bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50',
} as const;

/** Zinc count-pill as a raw class string, for spans that can't use <CountBadge>. */
export const countBadgeClass =
  'rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 whitespace-nowrap dark:bg-zinc-800 dark:text-zinc-400';

export const inputClass =
  'rounded-md border border-zinc-300 bg-white px-2 py-1 text-base sm:text-sm dark:border-zinc-700 dark:bg-zinc-900';

export const labelClass = 'text-xs font-medium text-zinc-600 dark:text-zinc-400';

/** Collapsible-section summary row (native <details>). */
export const summaryClass =
  'flex cursor-pointer list-none items-baseline gap-2 text-sm font-medium [&::-webkit-details-marker]:hidden';

export function PageHeader({ title, intro }: { title: string; intro?: ReactNode }) {
  return (
    <header>
      <h1 className="text-2xl font-semibold tracking-[-0.03em] text-slate-950 dark:text-zinc-100">
        {title}
      </h1>
      {intro ? (
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-zinc-400">
          {intro}
        </p>
      ) : null}
    </header>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 ${className}`}
    >
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
      className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap ${badgeTones[tone]}`}
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
      {hint ? (
        <span className="text-xs font-normal text-zinc-500 dark:text-zinc-500">{hint}</span>
      ) : null}
    </h2>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{children}</p>;
}
