'use client';

import {
  Brain,
  Check,
  ChevronLeft,
  CircleDollarSign,
  FileText,
  Lightbulb,
  ListChecks,
  LogOut,
  type LucideIcon,
  Menu,
  MessageCircle,
  MoreHorizontal,
  Settings,
  ShieldCheck,
  Target,
  TrendingUp,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { focusRing } from '@/lib/ui';
import { signOutAction } from './actions';

interface NavItem {
  href: string;
  label: string;
  utility?: boolean;
  system?: boolean;
}

const navIcons: Record<string, LucideIcon> = {
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

export function MobileNavBloom({
  navItems,
  pendingApprovals,
  signedIn,
  memoryReviewCount,
  needsAttentionCount,
}: {
  navItems: NavItem[];
  pendingApprovals: number;
  signedIn: boolean;
  memoryReviewCount: number;
  needsAttentionCount: number;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [layer, setLayer] = useState<'primary' | 'secondary'>('primary');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const signOutFormRef = useRef<HTMLFormElement>(null);
  const openRef = useRef(open);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const openMenu = useCallback(() => {
    setLayer('primary');
    setRendered(true);
    window.requestAnimationFrame(() => setOpen(true));
  }, []);

  const closeMenu = useCallback(() => {
    setOpen(false);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRendered(false);
      return;
    }
    window.setTimeout(() => {
      if (!openRef.current) setRendered(false);
    }, 180);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: close after route navigation
  useEffect(() => {
    if (openRef.current) closeMenu();
  }, [pathname, closeMenu]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
        return;
      }
      if (event.key !== 'Tab') return;

      const menuControls = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0 && element.tabIndex >= 0);
      const focusable = triggerRef.current ? [triggerRef.current, ...menuControls] : menuControls;
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

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => triggerRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      triggerRef.current?.focus();
    };
  }, [open, closeMenu]);

  const activeHref = navItems
    .filter((item) => (item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  const primaryItems = navItems.filter((item) => !item.utility && !item.system);
  const secondaryItems = navItems.filter((item) => item.utility || item.system);
  const totalAttention = pendingApprovals + memoryReviewCount + needsAttentionCount;

  const renderNavItem = (item: NavItem) => {
    const Icon = navIcons[item.href] ?? Menu;
    const active = item.href === activeHref;
    const count = badgeCountFor(
      item.href,
      pendingApprovals,
      memoryReviewCount,
      needsAttentionCount,
    );

    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? 'page' : undefined}
        aria-label={count > 0 ? `${item.label}, ${count} items need attention` : undefined}
        onClick={closeMenu}
        className={`nav-mobile-menu-row mobile-touch-target ${focusRing}`}
      >
        <span className="nav-mobile-menu-icon">
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <strong>{item.label}</strong>
        {count > 0 ? (
          <span className="nav-mobile-menu-count" aria-hidden="true">
            {formatBadgeCount(count)}
          </span>
        ) : active ? (
          <Check className="size-4 text-accent" aria-hidden="true" />
        ) : null}
      </Link>
    );
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-attention={totalAttention > 0}
        aria-label={open ? 'Close navigation menu' : 'Open navigation menu'}
        aria-expanded={open}
        aria-controls="mobile-nav"
        onClick={() => {
          if (open) closeMenu();
          else openMenu();
        }}
        className={`nav-mobile-menu-trigger mobile-touch-target lg:hidden ${focusRing}`}
      >
        <Menu className="size-5" aria-hidden="true" />
        {totalAttention > 0 ? (
          <span className="nav-mobile-menu-trigger-count" aria-hidden="true">
            {formatBadgeCount(totalAttention)}
          </span>
        ) : null}
      </button>

      {rendered ? (
        <div
          id="mobile-nav"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mobile-nav-title"
          data-open={open}
          inert={!open}
          className="nav-mobile-menu-dialog lg:hidden"
        >
          <span id="mobile-nav-title" className="sr-only">
            Navigation menu
          </span>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Close navigation menu"
            onClick={closeMenu}
            className="nav-mobile-menu-scrim"
          />
          <div
            ref={panelRef}
            data-open={open}
            data-layer={layer}
            onTransitionEnd={(event) => {
              if (event.target === event.currentTarget && !open) setRendered(false);
            }}
            className="nav-mobile-menu-panel"
          >
            <div className="nav-mobile-menu-pointer" aria-hidden="true" />
            <div className="nav-mobile-menu-scroll scroll-subtle">
              <div data-visible={layer === 'primary'} inert={layer !== 'primary'}>
                <nav aria-label="Primary navigation" className="nav-mobile-menu-list">
                  {primaryItems.map(renderNavItem)}
                  {secondaryItems.length > 0 || signedIn ? (
                    <>
                      <span className="nav-mobile-menu-divider" aria-hidden="true" />
                      <button
                        type="button"
                        onClick={() => {
                          setLayer('secondary');
                          window.requestAnimationFrame(() => backRef.current?.focus());
                        }}
                        className={`nav-mobile-menu-row mobile-touch-target ${focusRing}`}
                      >
                        <span className="nav-mobile-menu-icon">
                          <MoreHorizontal className="size-5" aria-hidden="true" />
                        </span>
                        <strong>More</strong>
                      </button>
                    </>
                  ) : null}
                </nav>
              </div>

              <div data-visible={layer === 'secondary'} inert={layer !== 'secondary'}>
                <button
                  ref={backRef}
                  type="button"
                  onClick={() => setLayer('primary')}
                  className={`nav-mobile-menu-back mobile-touch-target ${focusRing}`}
                >
                  <ChevronLeft className="size-4" aria-hidden="true" />
                  Back
                </button>
                <span className="nav-mobile-menu-divider" aria-hidden="true" />
                <nav aria-label="More navigation" className="nav-mobile-menu-list">
                  {secondaryItems.map(renderNavItem)}
                  {signedIn ? (
                    <>
                      <span className="nav-mobile-menu-divider" aria-hidden="true" />
                      <button
                        type="button"
                        onClick={() => signOutFormRef.current?.requestSubmit()}
                        className={`nav-mobile-menu-row mobile-touch-target ${focusRing}`}
                      >
                        <span className="nav-mobile-menu-icon">
                          <LogOut className="size-5" aria-hidden="true" />
                        </span>
                        <strong>Sign out</strong>
                      </button>
                    </>
                  ) : null}
                </nav>
              </div>
            </div>
          </div>
          {signedIn ? <form ref={signOutFormRef} action={signOutAction} /> : null}
        </div>
      ) : null}
    </>
  );
}
