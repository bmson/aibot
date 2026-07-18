'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CountBadge } from '@/lib/ui';
import { signOutAction } from './actions';

interface NavItem {
  href: string;
  label: string;
  utility?: boolean;
}

/**
 * App navigation. On large screens it's the persistent left sidebar; on small
 * screens it collapses to a sticky top bar with a slide-in drawer so the nav
 * doesn't eat half the viewport on a phone.
 */
export function AppNav({
  navItems,
  pendingApprovals,
  signedIn,
}: {
  navItems: NavItem[];
  pendingApprovals: number;
  signedIn: boolean;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the drawer whenever the route changes (a link was tapped).
  // biome-ignore lint/correctness/useExhaustiveDependencies: close on navigation
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // While the drawer is open, lock body scroll and close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  const renderLinks = (items: NavItem[], tone: 'rail' | 'drawer') =>
    items.map((item) => {
      const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
      return (
        <Link
          key={item.href}
          href={item.href}
          aria-current={active ? 'page' : undefined}
          className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${
            tone === 'rail'
              ? active
                ? 'bg-white/12 font-medium text-white shadow-sm'
                : 'text-slate-300 hover:bg-white/7 hover:text-white'
              : active
                ? 'bg-slate-900 font-medium text-white'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100'
          }`}
        >
          {item.label}
          {item.href === '/approvals' && pendingApprovals > 0 ? (
            <CountBadge tone="amber">{pendingApprovals}</CountBadge>
          ) : null}
        </Link>
      );
    });

  const signOut = signedIn ? (
    <form action={signOutAction}>
      <button type="submit" className="text-xs text-slate-400 hover:text-white hover:underline">
        Sign out
      </button>
    </form>
  ) : null;

  const primaryItems = navItems.filter((item) => !item.utility);
  const utilityItems = navItems.filter((item) => item.utility);

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col bg-slate-950 text-white lg:flex">
        <div className="px-5 pt-6 pb-7">
          <Link href="/" className="group inline-flex flex-col gap-1">
            <span className="text-[10px] font-semibold tracking-[0.18em] text-indigo-300 uppercase">
              Personal assistant
            </span>
            <span className="text-lg font-semibold tracking-[-0.03em]">Assistant</span>
          </Link>
        </div>
        <nav className="flex flex-col gap-1 px-3">{renderLinks(primaryItems, 'rail')}</nav>
        {utilityItems.length > 0 ? (
          <div className="mt-6 px-3">
            <p className="px-3 text-[10px] font-semibold tracking-[0.14em] text-slate-500 uppercase">
              Manage
            </p>
            <nav className="mt-2 flex flex-col gap-1">{renderLinks(utilityItems, 'rail')}</nav>
          </div>
        ) : null}
        {signOut ? (
          <div className="mt-auto border-t border-white/10 px-5 py-4">{signOut}</div>
        ) : null}
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-slate-800 bg-slate-950/95 px-4 text-white backdrop-blur lg:hidden">
        <Link href="/" className="text-sm font-semibold tracking-[-0.02em]">
          Assistant
        </Link>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation menu"
          aria-expanded={open}
          aria-controls="mobile-nav"
          className="relative -mr-2 inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-200 hover:bg-white/10"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <title>Menu</title>
            <path
              d="M3 5h14M3 10h14M3 15h14"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          {pendingApprovals > 0 ? (
            <span
              className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-amber-500"
              aria-hidden="true"
            />
          ) : null}
        </button>
      </header>

      {/* Mobile drawer */}
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-slate-950/50 backdrop-blur-sm"
          />
          <div
            id="mobile-nav"
            className="absolute inset-y-0 right-0 flex w-72 max-w-[84%] flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 px-4 dark:border-zinc-800">
              <span className="text-sm font-semibold tracking-[-0.02em]">Menu</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close navigation menu"
                className="-mr-2 inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <title>Close</title>
                  <path
                    d="M5 5l10 10M15 5L5 15"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
            <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
              {renderLinks(primaryItems, 'drawer')}
              {utilityItems.length > 0 ? (
                <>
                  <p className="mt-5 px-3 text-[10px] font-semibold tracking-[0.14em] text-slate-400 uppercase">
                    Manage
                  </p>
                  {renderLinks(utilityItems, 'drawer')}
                </>
              ) : null}
            </nav>
            {signOut ? (
              <div className="shrink-0 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
                <form action={signOutAction}>
                  <button
                    type="submit"
                    className="text-xs text-slate-500 hover:text-slate-950 hover:underline dark:text-zinc-500 dark:hover:text-zinc-100"
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
