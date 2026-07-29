'use client';

import {
  Brain,
  ChevronRight,
  CircleDollarSign,
  FileText,
  Gauge,
  Lightbulb,
  ListChecks,
  Menu,
  MessageCircle,
  PanelLeftClose,
  Settings,
  ShieldCheck,
  Target,
  TrendingUp,
  TriangleAlert,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createElement, type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { focusRing } from '@/lib/ui';
import { ActionMenu } from '@/lib/ui-client';
import { signOutAction } from './actions';
import { type AssistantPresence, AvatarMark, BrandLockup } from './brand-mark';
import { type JellyButtonElement, JellyIconButton } from './jelly-icon-button';
import { ThemeToggle } from './theme-toggle';

interface NavItem {
  href: string;
  label: string;
  utility?: boolean;
  system?: boolean;
}

/** Icons live here (client side) — nav data stays serializable in layout.tsx. */
const navIcons: Record<string, typeof MessageCircle> = {
  '/chat': MessageCircle,
  '/approvals': ShieldCheck,
  '/tasks': ListChecks,
  '/goals': Target,
  '/profile': Brain,
  '/documents': FileText,
  '/skills': Lightbulb,
  '/settings': Settings,
  '/costs': CircleDollarSign,
  '/anomalies': TriangleAlert,
  '/improvements': TrendingUp,
};

function badgeCountFor(
  href: string,
  pendingApprovals: number,
  memoryReviewCount: number,
  needsAttentionCount: number,
): number {
  if (href === '/approvals') return pendingApprovals;
  if (href === '/profile') return memoryReviewCount;
  if (href === '/tasks') return needsAttentionCount;
  return 0;
}

function formatBadgeCount(count: number): string {
  return count >= 1_000 ? `${(count / 1_000).toFixed(1)}k` : String(count);
}

function JellyCountBadge({ count, title }: { count: number; title?: string }) {
  return createElement(
    'jelly-badge',
    {
      className: 'nav-jelly-badge',
      size: 'small',
      title,
      variant: 'amber',
    },
    formatBadgeCount(count),
  );
}

function JellyNavTooltip({
  children,
  enabled,
  text,
}: {
  children: ReactElement;
  enabled: boolean;
  text: string;
}) {
  if (!enabled) return children;
  return createElement(
    'jelly-tooltip',
    {
      className: 'nav-tooltip',
      placement: 'right',
      size: 'small',
      text,
    },
    children,
  );
}

/**
 * App navigation. On large screens it's a floating rail — inset from the
 * viewport, collapsible to icon-only — and on small screens a floating top
 * bar with a slide-in drawer, so the nav doesn't eat half the viewport on a
 * phone. Every tile keeps a fixed-width icon gutter that never moves between
 * rail states: collapsing reads as the label receding from a stationary icon,
 * not the row itself scaling.
 */
export function AppNav({
  navItems,
  pendingApprovals,
  signedIn,
  agentName,
  presence,
  memoryReviewCount,
  needsAttentionCount,
}: {
  navItems: NavItem[];
  pendingApprovals: number;
  signedIn: boolean;
  agentName: string;
  presence: AssistantPresence;
  memoryReviewCount: number;
  needsAttentionCount: number;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // The drawer stays mounted through its own closing transition (`open` flips
  // false immediately, `rendered` lags behind until the CSS transition ends),
  // so closing plays the same slide/fade the opening does instead of the
  // panel vanishing on the first frame.
  const [rendered, setRendered] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const menuTriggerRef = useRef<JellyButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<JellyButtonElement>(null);
  // Read inside the close-fallback timeout, not captured by its closure — a
  // rapid re-open within the fallback's window must not have the stale timer
  // unmount the drawer out from under it.
  const openRef = useRef(open);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // Sets `rendered` synchronously alongside `open` (React batches both into
  // one render) rather than deriving it in a follow-up effect. Opening had a
  // real, CI-caught race: the focus-trap effect's rAF(() =>
  // closeButtonRef.current?.focus()) also fires off `open` changing, and if
  // `rendered` only flips true a render later, that rAF can land before the
  // drawer (and its close button) has actually mounted — focus silently goes
  // nowhere. Setting both here guarantees the drawer is already in the DOM by
  // the render the focus-trap effect runs against.
  const openDrawer = () => {
    setRendered(true);
    setOpen(true);
  };

  // Hydrate from the class the no-flash inline script (layout.tsx) already
  // stamped on <html> pre-paint — same pattern as ThemeToggle's `dark` state.
  useEffect(() => {
    setCollapsed(document.documentElement.classList.contains('nav-collapsed'));
  }, []);

  const toggleCollapsed = () => {
    const next = !collapsed;
    document.documentElement.classList.toggle('nav-collapsed', next);
    setCollapsed(next);
    try {
      localStorage.setItem('nav-collapsed', next ? '1' : '0');
    } catch {
      // Private mode or blocked storage — still applies for this session.
    }
  };

  const closeDrawer = useCallback(() => {
    setOpen(false);
    // Reduced-motion users get no CSS transition, so there is no
    // transitionend to unmount on — close the DOM immediately instead.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRendered(false);
      return;
    }
    // `inert` (set on the panel the instant it starts closing, so it can't be
    // tabbed into or clicked mid-exit) appears to suppress `transitionend`
    // from reaching the handler on the panel in at least some engines, which
    // would otherwise leave the drawer mounted — invisible but still in the
    // DOM — forever. A timeout just past the longer of the two closing
    // transitions (220ms) is the guaranteed fallback, same belt-and-suspenders
    // pattern as the theme wipe's own unstick timer. The ref guard means a
    // rapid re-open inside that window is not unmounted by the stale timer.
    window.setTimeout(() => {
      if (!openRef.current) setRendered(false);
    }, 260);
  }, []);

  // Close the drawer whenever the route changes (a link was tapped).
  // biome-ignore lint/correctness/useExhaustiveDependencies: close on navigation
  useEffect(() => {
    closeDrawer();
  }, [pathname]);

  // While the drawer is open, contain keyboard focus, lock body scroll, and
  // return focus to the trigger when it closes. Keyed on `open`, not
  // `rendered`: focus and scroll restore the instant the owner asks to close,
  // not after the panel finishes animating away.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeDrawer();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        drawerRef.current?.querySelectorAll<HTMLElement>(
          'jelly-button:not([disabled]), a[href], button:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
        // Links inside a closed <details> (the System group) are in the DOM but
        // not tabbable — counting them as first/last breaks the wrap. Chrome
        // hides them via content-visibility, which only checkVisibility sees.
      ).filter((element) =>
        typeof element.checkVisibility === 'function'
          ? element.checkVisibility()
          : element.getClientRects().length > 0,
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      menuTriggerRef.current?.focus();
    };
  }, [open, closeDrawer]);

  // Longest matching nav href wins, so /chat/all doesn't also light up /chat.
  const activeHref = navItems
    .filter((item) => (item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  const renderLinks = (items: NavItem[], tone: 'rail' | 'drawer') =>
    items.map((item) => {
      const active = item.href === activeHref;
      const Icon = navIcons[item.href];
      const collapseAware = tone === 'rail';
      const count = badgeCountFor(
        item.href,
        pendingApprovals,
        memoryReviewCount,
        needsAttentionCount,
      );
      const badgeTitle =
        item.href === '/profile' && count > 0
          ? `${count.toLocaleString()} ${count === 1 ? 'memory needs' : 'memories need'} your review`
          : item.href === '/tasks' && count > 0
            ? `${count.toLocaleString()} ${count === 1 ? 'task needs' : 'tasks need'} your attention`
            : item.href === '/approvals' && count > 0
              ? `${count.toLocaleString()} pending ${count === 1 ? 'approval' : 'approvals'}`
              : undefined;
      const link = (
        <Link
          href={item.href}
          data-mobile-touch-target="true"
          aria-current={active ? 'page' : undefined}
          className={`nav-tile mobile-touch-target relative grid h-10 w-full grid-cols-[2.5rem_1fr_auto] items-center gap-1 rounded-xl text-sm motion-safe:transition-[background-color,color,box-shadow] ${collapseAware && collapsed ? '' : 'pr-3'} ${focusRing} ${
            active
              ? 'nav-tile-active font-semibold'
              : 'font-medium text-zinc-600 hover:bg-sunken hover:text-strong active:bg-sunken dark:text-zinc-400 dark:hover:text-zinc-100'
          }`}
        >
          <span className="flex size-10 shrink-0 items-center justify-center">
            {Icon ? (
              <span
                className={`flex size-6 items-center justify-center rounded-lg ${
                  active ? 'bg-accent/10' : ''
                }`}
              >
                <Icon
                  className={`size-4 shrink-0 ${active ? '' : 'opacity-70'}`}
                  aria-hidden="true"
                />
              </span>
            ) : null}
            {collapseAware && count > 0 ? (
              <span
                aria-hidden="true"
                className="nav-badge-dot absolute top-1 right-1 size-3 rounded-full bg-amber-500 ring-2 ring-raised"
              />
            ) : null}
          </span>
          <span
            className={`min-w-0 truncate tracking-[-0.01em] ${collapseAware ? 'nav-label' : ''}`}
          >
            {item.label}
          </span>
          {count > 0 ? (
            <span className={`flex items-center ${collapseAware ? 'nav-label' : ''}`}>
              <JellyCountBadge count={count} title={badgeTitle} />
            </span>
          ) : (
            <span />
          )}
        </Link>
      );
      return (
        <JellyNavTooltip
          key={item.href}
          enabled={collapseAware && collapsed}
          text={`${item.label}${count > 0 ? ` · ${count}` : ''}`}
        >
          {link}
        </JellyNavTooltip>
      );
    });

  // Mobile drawer: an inline disclosure, indented under its own label — there's
  // no floating-panel real estate to spare in a 288px-wide slide-in panel, and
  // the whole drawer is already an overlay.
  const renderSystemDisclosure = (items: NavItem[]) => {
    const containsCurrent = items.some((item) => item.href === activeHref);
    return (
      <details className="group mt-1" open={containsCurrent || undefined}>
        <summary
          className={`nav-tile mobile-touch-target grid h-10 cursor-pointer grid-cols-[2.5rem_1fr_auto] items-center gap-1 rounded-xl pr-3 text-sm font-medium select-none hover:bg-sunken hover:text-strong dark:hover:text-zinc-100 ${focusRing} ${
            containsCurrent ? 'text-accent' : 'text-zinc-600 dark:text-zinc-400'
          }`}
        >
          <span className="flex size-10 shrink-0 items-center justify-center">
            <Gauge className="size-4 shrink-0 opacity-70" aria-hidden="true" />
          </span>
          <span className="min-w-0 truncate">System</span>
          <ChevronRight
            className="size-3.5 opacity-60 motion-safe:transition-transform group-open:rotate-90"
            aria-hidden="true"
          />
        </summary>
        <div className="mt-1 flex flex-col gap-1 pl-3">{renderLinks(items, 'drawer')}</div>
      </details>
    );
  };

  // Desktop rail: a floating dropdown instead of an inline accordion — expanding
  // in place pushed everything below it down every time it opened, and in the
  // collapsed rail there was no room for an indented sub-list at all.
  const renderSystemDropdown = (items: NavItem[]) => {
    const containsCurrent = items.some((item) => item.href === activeHref);
    return (
      <ActionMenu
        trigger={
          <>
            <span className="flex size-10 shrink-0 items-center justify-center">
              <Gauge className="size-4 shrink-0 opacity-70" aria-hidden="true" />
            </span>
            <span className="nav-label min-w-0 truncate">System</span>
            <ChevronRight className="nav-label size-3.5 opacity-60" aria-hidden="true" />
          </>
        }
        triggerTitle={collapsed ? 'System' : undefined}
        triggerClassName={`nav-tile mobile-touch-target grid h-10 w-full cursor-pointer grid-cols-[2.5rem_1fr_auto] items-center gap-1 rounded-xl text-sm font-medium motion-safe:transition-colors hover:bg-sunken hover:text-strong dark:hover:text-zinc-100 ${containsCurrent ? 'text-accent' : 'text-zinc-600 dark:text-zinc-400'} ${collapsed ? '' : 'pr-3'} ${focusRing}`}
        panelClassName="w-48"
      >
        {renderLinks(items, 'drawer')}
      </ActionMenu>
    );
  };

  const renderSystemGroup = (items: NavItem[], tone: 'rail' | 'drawer') =>
    items.length > 0
      ? tone === 'rail'
        ? renderSystemDropdown(items)
        : renderSystemDisclosure(items)
      : null;

  const signOut = signedIn ? (
    <form action={signOutAction}>
      <button
        type="submit"
        className={`rounded text-xs text-muted hover:text-strong hover:underline ${focusRing}`}
      >
        Sign out
      </button>
    </form>
  ) : null;

  const primaryItems = navItems.filter((item) => !item.utility && !item.system);
  const utilityItems = navItems.filter((item) => item.utility);
  const systemItems = navItems.filter((item) => item.system);

  return (
    <>
      {/* Desktop rail. Floats inset from the viewport rather than sitting flush
          against it, and collapses to icon-only via the `nav-rail`/`nav-label`
          CSS classes (globals.css), which read the `--rail-w` custom property
          that the `nav-collapsed` class on <html> overrides — same mechanism
          as `.dark` overriding color tokens above it in globals.css.
          bg-raised/border-edge, the same tokens every other panel in the app
          uses (message bubbles, form cards) — a permanently-dark rail read as
          heavier than the rest of the UI rather than as a floating peer of it. */}
      <aside
        className={`nav-rail hidden shrink-0 flex-col rounded-[1.4rem] border border-edge bg-raised text-strong shadow-[0_20px_50px_-24px_rgb(15_23_42/0.32)] dark:shadow-[0_20px_50px_-24px_rgb(0_0_0/0.7)] lg:m-4 lg:flex lg:sticky lg:top-4 lg:h-[calc(100dvh-var(--app-chrome,0px)-2rem)] xl:m-5 xl:top-5 xl:h-[calc(100dvh-var(--app-chrome,0px)-2.5rem)]`}
      >
        {/* Brand row: the mark anchors the rail's identity and doubles as a
            home (chat) link, with the collapse toggle in the trailing slot.
            The mark sits in the same fixed-width gutter as every tile icon
            below it (`nav-header`'s padding matches the tile nav's `px-3`),
            so the whole column — mark, tiles, footer icon — shares one left
            edge and one visual center in both rail states. Collapsed, the
            name leaves layout and the toggle stacks under the mark
            (globals.css), so the rail still leads with the assistant's face.
            The visible name is decoration for the link beside it — the link
            itself carries the accessible label. */}
        <div className="nav-header flex shrink-0 items-center gap-1 pt-5 pb-6">
          <Link
            href="/chat"
            aria-label={`${agentName} — open chat`}
            title={collapsed ? agentName : undefined}
            className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${focusRing}`}
          >
            <AvatarMark name={agentName} presence={presence} />
          </Link>
          <span
            aria-hidden="true"
            className="nav-label min-w-0 flex-1 truncate font-display text-[15px] font-semibold tracking-[-0.02em]"
          >
            {agentName}
          </span>
          <span className="flex size-10 shrink-0 items-center justify-center">
            <JellyIconButton
              onClick={toggleCollapsed}
              label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
              title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            >
              <PanelLeftClose className="nav-toggle-icon size-4" aria-hidden="true" />
            </JellyIconButton>
          </span>
        </div>
        <div className="scroll-subtle min-h-0 flex-1 overflow-y-auto pb-4">
          <nav className="nav-tile-list flex flex-col gap-1 px-3">
            {renderLinks(primaryItems, 'rail')}
          </nav>
          <div className="nav-manage-group px-3">
            <p className="nav-label px-3 font-display text-2xs font-semibold tracking-[0.14em] text-muted uppercase">
              Manage
            </p>
            <nav className="nav-tile-list mt-2 flex flex-col gap-1">
              {renderLinks(utilityItems, 'rail')}
              {renderSystemGroup(systemItems, 'rail')}
            </nav>
          </div>
        </div>
        <div className="nav-footer flex shrink-0 items-center justify-between border-t border-edge px-5 py-4">
          <span className="nav-label">{signOut ?? <span />}</span>
          {/* Same size-10 gutter as the header toggle and every tile icon, so
              the theme toggle lands in the same column once collapsed instead
              of hugging the footer's own (wider) right padding. */}
          <span className="nav-footer-icon flex size-10 shrink-0 items-center justify-center">
            <ThemeToggle />
          </span>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-3 z-30 m-3 flex h-14 items-center justify-between rounded-2xl border border-edge bg-raised/95 px-4 text-strong shadow-[0_8px_20px_-6px_rgb(0_0_0/0.14)] backdrop-blur dark:shadow-[0_8px_20px_-6px_rgb(0_0_0/0.35)] lg:hidden">
        <Link
          href="/chat"
          data-mobile-touch-target="true"
          className={`mobile-touch-target inline-flex items-center rounded-lg text-sm font-semibold tracking-[-0.02em] ${focusRing}`}
        >
          <span className="inline-flex items-center gap-2">
            <span className="scale-90">
              <BrandLockup name={agentName} presence={presence} />
            </span>
          </span>
        </Link>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <JellyIconButton
            buttonRef={menuTriggerRef}
            onClick={openDrawer}
            label="Open navigation menu"
            expanded={open}
            controls="mobile-nav"
            className="-mr-1"
          >
            <Menu className="size-5" aria-hidden="true" />
            {pendingApprovals > 0 ? (
              <span
                className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-amber-500"
                aria-hidden="true"
              />
            ) : null}
          </JellyIconButton>
        </div>
      </header>

      {/* Mobile drawer. Stays mounted (via `rendered`) through its own close
          transition — data-open drives .nav-scrim/.nav-drawer in globals.css,
          and `inert` while closing keeps it out of tab order and unclickable
          without waiting for the animation to finish. */}
      {rendered ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation menu"
            aria-hidden="true"
            tabIndex={-1}
            onClick={closeDrawer}
            data-open={open}
            className={`nav-scrim absolute inset-0 bg-zinc-950/50 backdrop-blur-sm ${open ? '' : 'pointer-events-none'}`}
          />
          <div
            ref={drawerRef}
            id="mobile-nav"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-nav-title"
            data-open={open}
            inert={!open}
            onTransitionEnd={(event) => {
              if (event.target === event.currentTarget && !open) setRendered(false);
            }}
            className="nav-drawer absolute inset-y-3 right-3 flex w-72 max-w-[calc(84%-0.75rem)] flex-col rounded-2xl border border-edge bg-raised shadow-2xl"
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-edge px-4">
              {/* Same eyebrow vocabulary as the "Manage" group label below —
                  the drawer's chrome shouldn't out-weigh its destinations. */}
              <span
                id="mobile-nav-title"
                className="font-display text-2xs font-semibold tracking-[0.14em] text-muted uppercase"
              >
                Menu
              </span>
              <JellyIconButton
                buttonRef={closeButtonRef}
                onClick={closeDrawer}
                label="Close navigation menu"
                className="-mr-1"
              >
                <X className="size-5" aria-hidden="true" />
              </JellyIconButton>
            </div>
            <nav className="scroll-subtle flex flex-1 flex-col gap-1 overflow-y-auto p-3">
              {renderLinks(primaryItems, 'drawer')}
              <p className="mt-6 px-3 font-display text-2xs font-semibold tracking-[0.14em] text-muted uppercase">
                Manage
              </p>
              {renderLinks(utilityItems, 'drawer')}
              {renderSystemGroup(systemItems, 'drawer')}
            </nav>
            {signOut ? (
              <div className="shrink-0 border-t border-edge px-5 py-4">
                <form action={signOutAction}>
                  <button
                    type="submit"
                    className={`inline-flex min-h-11 items-center rounded text-xs text-muted hover:text-strong hover:underline ${focusRing}`}
                  >
                    Sign out
                  </button>
                </form>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
