import type { ReactNode } from 'react';

// Shared UI primitives: the one place button/badge/card/section styling
// lives. Class-string constants (not components) where client components
// need to compose them with their own handlers.

/** Visible keyboard-focus ring shared by buttons, links, and menu items. */
export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-surface';

const btnBase = `mobile-touch-target inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium motion-safe:transition-[transform,background-color,border-color,color,box-shadow] motion-safe:active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
const btnMd = 'h-9 rounded-lg px-3.5 text-[13px]';
const btnXs = 'h-8 rounded-lg px-3 text-xs';

const btnVariants = {
  outline:
    'border border-edge text-zinc-700 hover:bg-sunken/70 hover:text-strong active:bg-sunken dark:text-zinc-300',
  dangerOutline:
    'border border-red-300 text-red-700 hover:bg-red-50 active:bg-red-100 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40 dark:active:bg-red-950/70',
  primary:
    'bg-accent text-white shadow-sm hover:bg-accent-hover hover:shadow-[0_5px_14px_rgb(91_92_226/0.22)] active:shadow-none',
  danger: 'bg-red-600 text-white hover:bg-red-700 active:bg-red-800',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800',
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

/** A loading placeholder block — used by route-level loading.tsx skeletons.
 *  A light sheen sweeps across it while motion is allowed; reduced-motion
 *  readers get the plain static block. */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`relative overflow-hidden rounded-md bg-zinc-200/70 after:absolute after:inset-0 after:-translate-x-full after:bg-gradient-to-r after:from-transparent after:via-white/50 after:to-transparent motion-safe:after:animate-[skeleton-sheen_1.5s_ease-in-out_infinite] dark:bg-zinc-800/70 dark:after:via-white/10 ${className}`}
    />
  );
}

export const inputClass =
  'h-9 rounded-lg border border-edge bg-raised px-3 text-base text-strong outline-none placeholder:text-muted/70 motion-safe:transition-shadow focus:border-accent focus:ring-2 focus:ring-accent/20 sm:text-sm';

export const textareaClass =
  'rounded-xl border border-edge bg-raised px-3 py-2.5 text-base text-strong outline-none placeholder:text-muted/70 motion-safe:transition-shadow focus:border-accent focus:ring-2 focus:ring-accent/20 sm:text-sm';

export const labelClass = 'text-[13px] font-medium text-muted';

/**
 * Cards use one shared information architecture:
 * identity at the top, primary content in the body, structured facts in a
 * compact grid, and actions in a quiet footer.
 */
export const cardShellClass =
  'min-w-0 overflow-hidden rounded-2xl bg-raised shadow-[0_1px_2px_rgb(23_25_35/0.06)] ring-1 ring-edge/60';
export const cardBodyClass = 'grid min-w-0 gap-4 p-4 sm:p-5';
export const cardHeaderClass = 'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3';
/** Footer chrome (divider + tonal well + padding), shared by the button-row
 *  footer and disclosure-style footers that can't be a flex container. */
export const cardFooterChromeClass = 'border-t border-edge/70 bg-sunken/35 px-4 py-3 sm:px-5';
export const cardFooterClass = `flex min-w-0 flex-wrap items-center gap-2 ${cardFooterChromeClass}`;

/** One card-title scale, so every card reads at the same weight. */
export const cardTitleClass = 'text-[15px] leading-6 font-semibold tracking-[-0.015em] text-strong';

/** Lift-on-hover for cards that are a link or have one dominant action. */
export const cardInteractiveClass =
  'motion-safe:transition-[box-shadow,transform] hover:-translate-y-0.5 hover:shadow-[0_10px_30px_rgb(23_25_35/0.08)]';

/**
 * Timeline event cards (chat): approvals, budget asks, system checks. A
 * wrapped, outlined object distinct from speech bubbles — process moments
 * should read as things the assistant placed in the conversation, not prose.
 */
export const eventCardClass =
  'min-w-0 max-w-full overflow-hidden rounded-xl bg-raised shadow-[0_1px_2px_rgb(23_25_35/0.05)] ring-1 ring-edge/70';

/** Two grid recipes, so pages stop inventing their own breakpoints. */
export const cardGridClass = 'grid min-w-0 items-stretch gap-4 lg:grid-cols-2';
export const tileGridClass = 'grid min-w-0 items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-3';

/** Collapsible-section summary row (native <details>). */
export const summaryClass =
  'flex cursor-pointer list-none items-baseline gap-2 text-sm font-medium [&::-webkit-details-marker]:hidden';

export function PageHeader({ title, intro }: { title: string; intro?: ReactNode }) {
  return (
    <header>
      <h1 className="font-display text-[1.875rem] leading-9 font-semibold tracking-[-0.035em] text-strong sm:text-[2rem] sm:leading-10">
        {title}
      </h1>
      {intro ? <p className="mt-2 max-w-[68ch] text-[15px] leading-6 text-muted">{intro}</p> : null}
    </header>
  );
}

export function PageShell({
  children,
  size = 'wide',
  className = '',
}: {
  children: ReactNode;
  size?: 'wide' | 'reading';
  className?: string;
}) {
  return (
    <div className={`mx-auto w-full ${size === 'wide' ? 'max-w-6xl' : 'max-w-4xl'} ${className}`}>
      {children}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`${cardShellClass} p-5 ${className}`}>{children}</div>;
}

export function InfoGrid({
  children,
  columns = 2,
  className = '',
}: {
  children: ReactNode;
  columns?: 1 | 2 | 3 | 4;
  className?: string;
}) {
  const columnClass = {
    1: 'grid-cols-1',
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-4',
  }[columns];
  return (
    <dl
      className={`grid min-w-0 ${columnClass} gap-px overflow-hidden rounded-xl bg-edge/70 ${className}`}
    >
      {children}
    </dl>
  );
}

export function InfoItem({
  label,
  children,
  className = '',
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`min-w-0 bg-sunken/65 px-3 py-2.5 ${className}`}>
      <dt className="text-2xs font-semibold tracking-[0.08em] text-muted uppercase">{label}</dt>
      <dd className="mt-0.5 min-w-0 break-words text-[13px] leading-5 font-medium text-strong [overflow-wrap:anywhere]">
        {children}
      </dd>
    </div>
  );
}

export function Panel({
  children,
  className = '',
  tone = 'raised',
}: {
  children: ReactNode;
  className?: string;
  tone?: 'raised' | 'sunken';
}) {
  return (
    <section
      className={`rounded-2xl p-5 sm:p-6 ${
        tone === 'raised' ? 'bg-raised shadow-[0_1px_2px_rgb(23_25_35/0.06)]' : 'bg-sunken/70'
      } ${className}`}
    >
      {children}
    </section>
  );
}

/**
 * One status/label pill for the whole app. Tones copy the exact light/dark
 * pairs already used by status chips (views.tsx), so migrating the ~10 bespoke
 * pills to <Badge> shifts nothing visually. Count pills keep <CountBadge>.
 */
export type BadgeTone =
  | 'neutral'
  | 'muted'
  | 'accent'
  | 'blue'
  | 'green'
  | 'amber'
  | 'red'
  | 'orange'
  | 'violet'
  | 'purple'
  | 'indigo';

const pillTones: Record<BadgeTone, string> = {
  neutral: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  muted: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500',
  accent: 'bg-accent/10 text-accent',
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  green: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  red: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  orange: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  violet: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
  purple: 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300',
  indigo: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300',
};

export function Badge({
  children,
  tone = 'neutral',
  size = 'sm',
  uppercase = false,
  title,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  size?: 'sm' | 'xs';
  uppercase?: boolean;
  title?: string;
}) {
  const sizeClass = uppercase
    ? 'px-2 py-0.5 text-2xs font-semibold tracking-[0.06em] uppercase'
    : size === 'xs'
      ? 'px-1.5 py-0.5 text-2xs'
      : 'px-2 py-0.5 text-xs';
  return (
    <span
      title={title}
      className={`inline-flex max-w-full items-center gap-1 rounded-full font-medium whitespace-nowrap ${sizeClass} ${pillTones[tone]}`}
    >
      {children}
    </span>
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
    <h2 className="flex min-w-0 flex-wrap items-baseline gap-2 text-[15px] font-semibold tracking-[-0.01em]">
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
  if (!icon && !action) return <p className="mt-3 text-[15px] leading-6 text-muted">{children}</p>;
  return (
    <div className="mt-3 flex flex-col items-start gap-2 rounded-2xl bg-sunken/55 px-5 py-6">
      {icon ? (
        <span aria-hidden="true" className="text-muted">
          {icon}
        </span>
      ) : null}
      <p className="text-[15px] leading-6 text-muted">{children}</p>
      {action}
    </div>
  );
}

export const segmentedControlClass =
  'inline-flex flex-wrap items-center gap-1 rounded-xl bg-sunken/80 p-1';

export const segmentedItemClass = `mobile-touch-target inline-flex h-8 items-center justify-center rounded-lg px-3 text-xs font-medium text-muted motion-safe:transition-colors hover:bg-raised hover:text-strong ${focusRing}`;

export const iconButtonClass = `mobile-touch-target inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-edge bg-raised text-muted motion-safe:transition-[background-color,color,transform] hover:bg-sunken hover:text-strong active:bg-sunken/80 motion-safe:active:translate-y-px ${focusRing}`;
