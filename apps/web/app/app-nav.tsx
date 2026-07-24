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
  Settings,
  ShieldCheck,
  Target,
  TrendingUp,
  TriangleAlert,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { CountBadge, focusRing } from '@/lib/ui';
import { signOutAction } from './actions';
import { type AssistantPresence, BrandLockup } from './brand-mark';
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

/**
 * App navigation. On large screens it's the persistent left sidebar; on small
 * screens it collapses to a sticky top bar with a slide-in drawer so the nav
 * doesn't eat half the viewport on a phone.
 */
export function AppNav({
  navItems,
  pendingApprovals,
  signedIn,
  agentName,
  presence,
  memoryReviewCount,
}: {
  navItems: NavItem[];
  pendingApprovals: number;
  signedIn: boolean;
  agentName: string;
  presence: AssistantPresence;
  memoryReviewCount: number;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Close the drawer whenever the route changes (a link was tapped).
  // biome-ignore lint/correctness/useExhaustiveDependencies: close on navigation
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // While the drawer is open, contain keyboard focus, lock body scroll, and
  // return focus to the trigger when it closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        drawerRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
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
  }, [open]);

  // Longest matching nav href wins, so /chat/all doesn't also light up /chat.
  const activeHref = navItems
    .filter((item) => (item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  const renderLinks = (items: NavItem[], tone: 'rail' | 'drawer') =>
    items.map((item) => {
      const active = item.href === activeHref;
      const Icon = navIcons[item.href];
      return (
        <Link
          key={item.href}
          href={item.href}
          data-mobile-touch-target="true"
          aria-current={active ? 'page' : undefined}
          className={`mobile-touch-target relative flex items-center justify-between rounded-lg px-3 py-2 text-sm motion-safe:transition-colors ${focusRing} ${
            active
              ? 'before:absolute before:top-1/2 before:-left-3 before:h-4 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-accent'
              : ''
          } ${
            tone === 'rail'
              ? active
                ? 'bg-white/12 font-medium text-white shadow-sm'
                : 'text-zinc-300 hover:bg-white/7 hover:text-white active:bg-white/10'
              : active
                ? 'bg-zinc-900 font-medium text-white'
                : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950 active:bg-zinc-200/70 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100 dark:active:bg-zinc-800'
          }`}
        >
          <span className="flex min-w-0 items-center gap-2.5">
            {Icon ? (
              <Icon
                className={`size-4 shrink-0 ${active ? '' : 'opacity-70'}`}
                aria-hidden="true"
              />
            ) : null}
            {item.label}
          </span>
          {item.href === '/approvals' && pendingApprovals > 0 ? (
            <CountBadge tone="amber">{pendingApprovals}</CountBadge>
          ) : item.href === '/profile' && memoryReviewCount > 0 ? (
            <span
              title={`${memoryReviewCount.toLocaleString()} ${
                memoryReviewCount === 1 ? 'memory needs' : 'memories need'
              } your review`}
            >
              <CountBadge tone="amber">
                {memoryReviewCount >= 1_000
                  ? `${(memoryReviewCount / 1_000).toFixed(1)}k`
                  : memoryReviewCount}
              </CountBadge>
            </span>
          ) : null}
        </Link>
      );
    });

  const renderSystemGroup = (items: NavItem[], tone: 'rail' | 'drawer') =>
    items.length > 0 ? (
      <details className="group mt-1">
        <summary
          className={`mobile-touch-target flex cursor-pointer list-none items-center gap-2.5 rounded-lg px-3 py-2 text-sm select-none [&::-webkit-details-marker]:hidden ${focusRing} ${
            tone === 'rail'
              ? 'text-zinc-400 hover:bg-white/7 hover:text-white'
              : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950 dark:hover:bg-zinc-900 dark:hover:text-zinc-100'
          }`}
        >
          <Gauge className="size-4 shrink-0 opacity-70" aria-hidden="true" />
          System
          <ChevronRight
            className="ml-auto size-3.5 opacity-60 motion-safe:transition-transform group-open:rotate-90"
            aria-hidden="true"
          />
        </summary>
        <div className="mt-1 flex flex-col gap-1 pl-3">{renderLinks(items, tone)}</div>
      </details>
    ) : null;

  const signOut = signedIn ? (
    <form action={signOutAction}>
      <button
        type="submit"
        className={`rounded text-xs text-zinc-400 hover:text-white hover:underline ${focusRing}`}
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
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col bg-[#0b0d12] text-white lg:flex">
        <div className="px-5 pt-6 pb-7">
          <Link href="/chat" className={`inline-flex rounded-lg ${focusRing}`}>
            <BrandLockup
              name={agentName}
              presence={presence}
              subtitle={
                <span
                  className={`text-2xs font-medium tracking-[0.14em] uppercase ${
                    presence === 'attention' ? 'text-amber-300' : 'text-indigo-300'
                  }`}
                >
                  {presence === 'attention'
                    ? 'Needs your attention'
                    : presence === 'working'
                      ? 'Working'
                      : 'Ready when you are'}
                </span>
              }
            />
          </Link>
        </div>
        <nav className="flex flex-col gap-1 px-3">{renderLinks(primaryItems, 'rail')}</nav>
        <div className="mt-6 px-3">
          <p className="px-3 text-2xs font-semibold tracking-[0.14em] text-zinc-500 uppercase">
            Manage
          </p>
          <nav className="mt-2 flex flex-col gap-1">
            {renderLinks(utilityItems, 'rail')}
            {renderSystemGroup(systemItems, 'rail')}
          </nav>
        </div>
        <div className="mt-auto flex items-center justify-between border-t border-white/10 px-5 py-4">
          {signOut ?? <span />}
          <ThemeToggle />
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-zinc-800 bg-[#0b0d12]/95 px-4 text-white backdrop-blur lg:hidden">
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
          <button
            ref={menuTriggerRef}
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open navigation menu"
            aria-expanded={open}
            aria-controls="mobile-nav"
            className={`relative -mr-2 inline-flex h-11 w-11 items-center justify-center rounded-lg text-zinc-200 hover:bg-white/10 ${focusRing}`}
          >
            <Menu className="size-5" aria-hidden="true" />
            {pendingApprovals > 0 ? (
              <span
                className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-amber-500"
                aria-hidden="true"
              />
            ) : null}
          </button>
        </div>
      </header>

      {/* Mobile drawer */}
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation menu"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-zinc-950/50 backdrop-blur-sm motion-safe:animate-[fade-in_150ms_ease-out]"
          />
          <div
            ref={drawerRef}
            id="mobile-nav"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-nav-title"
            className="absolute inset-y-0 right-0 flex w-72 max-w-[84%] flex-col border-l border-edge bg-raised shadow-2xl motion-safe:animate-[slide-in-right_200ms_ease-out]"
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 px-4 dark:border-zinc-800">
              <span id="mobile-nav-title" className="text-sm font-semibold tracking-[-0.02em]">
                Menu
              </span>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close navigation menu"
                className={`-mr-2 inline-flex h-11 w-11 items-center justify-center rounded-lg text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900 ${focusRing}`}
              >
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>
            <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
              {renderLinks(primaryItems, 'drawer')}
              <p className="mt-5 px-3 text-2xs font-semibold tracking-[0.14em] text-zinc-400 uppercase">
                Manage
              </p>
              {renderLinks(utilityItems, 'drawer')}
              {renderSystemGroup(systemItems, 'drawer')}
            </nav>
            {signOut ? (
              <div className="shrink-0 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
                <form action={signOutAction}>
                  <button
                    type="submit"
                    className={`inline-flex min-h-11 items-center rounded text-xs text-zinc-500 hover:text-zinc-950 hover:underline dark:text-zinc-500 dark:hover:text-zinc-100 ${focusRing}`}
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
