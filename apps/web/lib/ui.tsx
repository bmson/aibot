import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

// Shared UI primitives: the one place button/badge/card/section styling
// lives. Class-string constants (not components) where client components
// need to compose them with their own handlers.

/**
 * Visible keyboard-focus ring shared by buttons, links, and menu items.
 *
 * A real `outline` rather than ring + ring-offset: an offset ring has to paint
 * its gap in a fixed colour, and `ring-offset-surface` drew a pale halo around
 * every focused link on the dark nav rail. `outline-offset` leaves the gap
 * transparent, so the same ring reads correctly on the rail, on cards, and on
 * the canvas without any per-surface override.
 */
export const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

const btnBase = `mobile-touch-target inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium motion-safe:transition-[background-color,border-color,color,box-shadow] disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
const btnMd = 'h-9 rounded-lg px-3.5 text-sm';
const btnXs = 'h-8 rounded-lg px-3 text-xs';

const btnVariants = {
  outline:
    'border border-edge text-zinc-700 hover:bg-sunken/70 hover:text-strong active:bg-sunken dark:text-zinc-300',
  dangerOutline:
    'border border-red-300 text-red-700 hover:bg-red-50 active:bg-red-100 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40 dark:active:bg-red-950/70',
  // Flat: the accent plane is the emphasis. The old hover glow read as a
  // sticker hovering over the page rather than a control set into it.
  primary: 'bg-accent text-on-accent hover:bg-accent-hover',
  danger: 'bg-red-600 text-white hover:bg-red-700 active:bg-red-800',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800',
} as const;

/**
 * Rows inside an <ActionMenu> panel. A dropdown is a list of choices, not a
 * stack of buttons — so menu items are quiet, full-width, left-aligned rows
 * that only light up under the pointer. Not built on btnBase: its
 * justify-center would win the stylesheet-order fight against justify-start.
 */
const menuItem = `mobile-touch-target inline-flex h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium whitespace-nowrap motion-safe:transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
const menuVariants = {
  menu: `${menuItem} text-strong hover:bg-sunken active:bg-sunken/80`,
  menuDanger: `${menuItem} text-red-700 hover:bg-red-50 active:bg-red-100 dark:text-red-400 dark:hover:bg-red-950/40 dark:active:bg-red-950/70`,
} as const;

/** Default button scale — comfortable for primary actions and card controls. */
export const btn = {
  outline: `${btnBase} ${btnMd} ${btnVariants.outline}`,
  dangerOutline: `${btnBase} ${btnMd} ${btnVariants.dangerOutline}`,
  primary: `${btnBase} ${btnMd} ${btnVariants.primary}`,
  danger: `${btnBase} ${btnMd} ${btnVariants.danger}`,
  success: `${btnBase} ${btnMd} ${btnVariants.success}`,
  ...menuVariants,
} as const;

/** Dense scale for table rows and per-item micro-actions (old default size). */
export const btnSm = {
  outline: `${btnBase} ${btnXs} ${btnVariants.outline}`,
  dangerOutline: `${btnBase} ${btnXs} ${btnVariants.dangerOutline}`,
  primary: `${btnBase} ${btnXs} ${btnVariants.primary}`,
  danger: `${btnBase} ${btnXs} ${btnVariants.danger}`,
  success: `${btnBase} ${btnXs} ${btnVariants.success}`,
  ...menuVariants,
} as const;

/**
 * The app's structural voice: every micro-label that names a *part of the
 * interface* rather than saying something (eyebrow headings, group labels,
 * uppercase badges, the keys in fact grids) is set in the mono face and
 * letterspaced. Content and titles use the platform system face; mono is kept
 * only where the text is genuinely structural or data-like. Colour stays with
 * the caller — most compose this with text-muted, a few with a status colour.
 */
export const microLabelClass = 'font-mono text-xs font-medium tracking-[0.08em] uppercase';

/** Neutral count-pill as a raw class string, for spans that can't use <CountBadge>. */
export const countBadgeClass =
  'rounded-full bg-sunken px-1.5 py-0.5 font-mono text-xs font-medium text-muted whitespace-nowrap';

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

/**
 * Native <select>, sharing inputClass's metrics and focus treatment. The UA's
 * own arrow is dropped (`appearance-none`) — each engine drew a different
 * glyph and none of them followed the field's colours — and a token-coloured
 * chevron takes its place, supplied by globals.css as a custom property so
 * dark mode can swap the stroke without a second class here. The wider right
 * padding keeps the selected label clear of the arrow.
 */
export const selectClass = `${inputClass} cursor-pointer appearance-none bg-[image:var(--select-chevron)] bg-[length:1rem_1rem] bg-[position:right_0.625rem_center] bg-no-repeat pr-9`;

/** `field-sizing: content` grows the box with what's typed, so these need no
 *  resize grabber and no JS measuring — the min/max keep it in a sane band. */
export const textareaClass =
  'rounded-lg border border-edge bg-raised px-3 py-2.5 text-base text-strong outline-none resize-none [field-sizing:content] min-h-20 max-h-80 placeholder:text-muted/70 motion-safe:transition-shadow focus:border-accent focus:ring-2 focus:ring-accent/20 sm:text-sm';

export const labelClass = 'text-sm font-medium text-muted';

/**
 * Native file input, with its ::file-selector-button dressed to match the
 * outline button. The same class string was pasted into three upload forms and
 * had already drifted; this is the one copy. The "no file chosen" text beside
 * the button is browser chrome and cannot be restyled — it is left alone
 * rather than replaced with a JS-driven imitation.
 */
export const fileInputClass =
  'min-w-0 max-w-full text-sm text-muted file:mr-3 file:h-9 file:cursor-pointer file:rounded-lg file:border file:border-edge file:bg-raised file:px-3.5 file:text-sm file:font-medium file:text-strong motion-safe:file:transition-colors hover:file:bg-sunken active:file:bg-sunken/80';

/**
 * Cards use one shared information architecture:
 * identity at the top, primary content in the body, structured facts in a
 * compact grid, and actions in a quiet footer.
 *
 * The shell is a hairline-ringed plane, not a floating slab: no drop shadow,
 * and a radius one step tighter than the old 2xl. Depth in this UI comes
 * from tone (raised/sunken) and hairlines, which keeps every surface sitting
 * *in* the page's grid rather than hovering over it.
 */
export const cardShellClass =
  'reveal min-w-0 overflow-hidden rounded-xl bg-raised ring-1 ring-edge/70';
export const cardBodyClass = 'grid min-w-0 gap-4 p-4 sm:p-5';
export const cardHeaderClass = 'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3';
/** Footer chrome (divider + tonal well + padding), shared by the button-row
 *  footer and disclosure-style footers that can't be a flex container. */
export const cardFooterChromeClass = 'border-t border-edge/70 bg-sunken/35 px-4 py-3 sm:px-5';
export const cardFooterClass = `flex min-w-0 flex-wrap items-center gap-2 ${cardFooterChromeClass}`;

/** One card-title scale, in the display face — titles are the one place the
 *  brand's letterforms appear at reading size, so cards carry the same voice
 *  as the page title above them. */
export const cardTitleClass =
  'font-display text-base leading-6 font-semibold tracking-[-0.015em] text-strong';

/** Interactive cards sharpen in place: tone and the hairline carry the hover
 *  state without moving or lifting the card away from the page. */
export const cardInteractiveClass =
  'motion-safe:transition-[background-color,box-shadow] hover:bg-sunken/20 hover:ring-edge';

/** The shared grid recipe, so pages stop inventing their own breakpoints. */
export const cardGridClass = 'grid min-w-0 items-stretch gap-4 lg:grid-cols-2';

/** Collapsible-section summary row (native <details>). The `disclosure` class
 *  draws the rotating chevron and globals.css animates the panel itself, so
 *  every section built from this opens the same way. */
export const summaryClass =
  'disclosure flex cursor-pointer list-none items-center gap-2 text-sm font-medium';

/**
 * "Back to the parent surface" link above a detail page's title.
 *
 * There were three hand-rolled versions: two used the ArrowLeft icon and one a
 * literal "←" glyph in accent link styling, and only one of the three carried
 * the mobile touch target. One component, so a detail page can't drift again.
 */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={`mobile-touch-target mb-5 inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-muted motion-safe:transition-colors hover:text-strong ${focusRing}`}
    >
      <ArrowLeft className="size-3.5 shrink-0" aria-hidden="true" />
      {children}
    </Link>
  );
}

/**
 * Page title, optional intro, and optional page-level actions.
 *
 * `actions` pairs with the *title*, not with the whole header. Pages used to
 * wrap this in `flex flex-wrap justify-between` alongside their buttons, which
 * meant the long intro forced a wrap on narrow screens and dumped the button on
 * its own line under the paragraph, left-aligned and orphaned. Titles are short,
 * so keeping the action beside the title fits at every width and lets the intro
 * run the full measure beneath both.
 *
 * `back` is not optional in spirit. The app has no navigation chrome — you get
 * anywhere by typing "/" in the chat composer — so a page that does not name
 * its parent here is a page with no way out. Detail pages point at their list;
 * everything else points at the chat.
 */
export function PageHeader({
  title,
  intro,
  actions,
  back,
}: {
  title: string;
  intro?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  // text-balance/text-pretty stop a wrapped title or intro from stranding a
  // single word on its own last line.
  return (
    <header>
      {back ? <BackLink href={back.href}>{back.label}</BackLink> : null}
      <div className="flex min-w-0 items-start justify-between gap-3">
        {/* One stable page-title size on every viewport. The system display face
            already adapts optically, so it does not need a second mobile/desktop
            size or display-font-specific tracking. */}
        <h1 className="min-w-0 font-display text-3xl leading-9 font-semibold tracking-[-0.025em] text-balance text-strong">
          {title}
        </h1>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 pt-1">
            {actions}
          </div>
        ) : null}
      </div>
      {intro ? (
        <p className="mt-2 max-w-[68ch] text-base leading-6 text-pretty text-muted">{intro}</p>
      ) : null}
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
      <dt className={`${microLabelClass} text-muted`}>{label}</dt>
      <dd className="mt-0.5 min-w-0 break-words text-sm leading-5 font-medium text-strong tabular-nums [overflow-wrap:anywhere]">
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
      className={`rounded-xl p-5 sm:p-6 ${
        tone === 'raised' ? 'bg-raised ring-1 ring-edge/70' : 'bg-sunken/70'
      } ${className}`}
    >
      {children}
    </section>
  );
}

/**
 * One status/label pill for the whole app, and one color vocabulary behind it.
 * Each tone is a meaning, not a decoration:
 *
 *   neutral — a resting fact (queued, scheduled, a plain label)
 *   muted   — an ended state that no longer matters (cancelled, expired)
 *   accent  — the assistant is doing something right now
 *   green   — finished well / verified
 *   amber   — waiting on the owner
 *   red     — failed or declined
 *
 * Anything new must pick one of these meanings rather than a new hue; if none
 * fits, the pill is probably a neutral label. Count pills keep <CountBadge>.
 */
export type BadgeTone = 'neutral' | 'muted' | 'accent' | 'green' | 'amber' | 'red';

const pillTones: Record<BadgeTone, string> = {
  neutral: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  muted: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500',
  accent: 'bg-accent/10 text-accent',
  green: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  red: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
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
  // Uppercase pills join the mono micro-label voice — a status label is
  // structure, not prose (weight comes from the shared font-medium below).
  const sizeClass = uppercase
    ? 'px-2 py-0.5 font-mono text-xs tracking-[0.08em] uppercase'
    : size === 'xs'
      ? 'px-1.5 py-0.5 text-xs'
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
  // The neutral pill is `sunken`, not zinc-100: zinc-100 and the light canvas
  // (#f4f4f5 vs #f4f6fa) are the same colour to the eye, so a count sitting
  // directly on the page background simply vanished. `sunken` is defined as one
  // step below the canvas, so it reads on the page and on a raised card alike,
  // in both themes. Amber is the only other count tone — a count is either a
  // quiet figure or a "needs you" figure, nothing in between.
  zinc: 'bg-sunken text-muted',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
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
      className={`rounded-full px-1.5 py-0.5 font-mono text-xs font-medium whitespace-nowrap ${badgeTones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * The app's one metadata row: a quiet, dot-separated line of facts under a
 * title ("Started by You · $0.12 of $0.50 · Updated 2h ago"). Falsy segments
 * are dropped, so callers can pass conditional entries without ceremony.
 * Replaces the boxed chips and mini fact-grids that used to make every card
 * read like a dashboard.
 */
export function MetaLine({
  segments,
  className = '',
}: {
  segments: ReactNode[];
  className?: string;
}) {
  const metaSegmentClass =
    'flex min-w-0 max-w-full items-center gap-x-2 break-words whitespace-normal';
  const visible = segments.filter(
    (segment) => segment !== null && segment !== undefined && segment !== false && segment !== '',
  );
  if (visible.length === 0) return null;
  return (
    <p
      className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 text-muted ${className}`}
    >
      {visible.map((segment, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
        <span key={index} className={metaSegmentClass}>
          {index > 0 ? (
            <span aria-hidden="true" className="text-muted/60">
              ·
            </span>
          ) : null}
          {segment}
        </span>
      ))}
    </p>
  );
}

/**
 * Section headings are the page's grid armature: a mono micro-label with a
 * hairline rule running out to the full measure, so every section boundary
 * lands on the same visible line no matter what content follows. The label
 * is deliberately quiet — the big display title at the top of the page is
 * the only heading that speaks at content volume; everything below it just
 * names its region. (The rule is aria-hidden decoration; the h2 semantics
 * are unchanged.)
 */
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
    <h2 className="flex min-w-0 items-center gap-3">
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={`${microLabelClass} text-muted`}>{title}</span>
        {count !== undefined ? <CountBadge>{count}</CountBadge> : null}
        {hint ? <span className="text-xs font-normal text-muted/80">{hint}</span> : null}
      </span>
      <span aria-hidden="true" className="h-px min-w-6 flex-1 bg-edge/80" />
    </h2>
  );
}

/**
 * "Nothing here yet" always reads as a deliberate tonal panel. It used to fall
 * back to a bare paragraph whenever no icon or action was supplied, which is
 * nine of the ten uses — on a page whose entire body is empty (Skills, Filed
 * documents) that left a lone sentence floating in the void, looking more like
 * a rendering failure than a state.
 */
export function EmptyState({
  children,
  icon,
  action,
}: {
  children: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mt-3 flex flex-col items-start gap-3 rounded-xl bg-sunken/50 px-5 py-5 ring-1 ring-edge/40">
      {icon ? (
        <span aria-hidden="true" className="text-muted">
          {icon}
        </span>
      ) : null}
      <p className="max-w-[68ch] text-base leading-6 text-pretty text-muted">{children}</p>
      {action}
    </div>
  );
}

export const segmentedControlClass =
  'inline-flex flex-wrap items-center gap-1 rounded-xl bg-sunken/80 p-1';

const segmentedItemBase = `mobile-touch-target inline-flex h-8 items-center justify-center rounded-lg px-3 text-xs font-medium motion-safe:transition-colors ${focusRing}`;

/** Resting segment — quiet until hovered. */
export const segmentedItemClass = `${segmentedItemBase} text-muted hover:bg-raised hover:text-strong`;

/**
 * Selected segment. Pages used to append `bg-raised shadow-sm` themselves,
 * which read fine in light mode but inverted in dark, where the raised panel
 * is *darker* than the sunken track it sits on — the current filter looked
 * like a hole, and shadow-sm is invisible on charcoal anyway. The accent text
 * plus accent hairline is the same "you are here" vocabulary as the nav's
 * active tile, and reads on both tracks. A separate class (not a bolt-on)
 * so the resting hover styles can't fight the selected ones.
 */
export const segmentedItemActiveClass = `${segmentedItemBase} bg-raised text-accent ring-1 ring-accent/25`;
