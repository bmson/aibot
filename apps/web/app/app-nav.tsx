'use client';

import {
  Brain,
  ChevronRight,
  CircleDollarSign,
  FileText,
  Gauge,
  Lightbulb,
  ListChecks,
  type LucideIcon,
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
import { createElement, type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';
import { focusRing, microLabelClass } from '@/lib/ui';
import { signOutAction } from './actions';
import { type JellyButtonElement, JellyIconButton } from './jelly-icon-button';
import { MobileNavBloom } from './mobile-nav-bloom';
import { ThemeToggle } from './theme-toggle';

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

const navDescriptions: Record<string, string> = {
  '/chat': 'Talk, plan, and work together',
  '/approvals': 'Review decisions before they happen',
  '/tasks': 'See what is moving and what needs attention',
  '/goals': 'Shape the longer arc of the work',
  '/profile': 'Curate what the assistant remembers',
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

export function AppNav({
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
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<JellyButtonElement>(null);
  const openRef = useRef(open);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const openPalette = (event: MouseEvent<HTMLButtonElement>) => {
    menuTriggerRef.current = event.currentTarget;
    setRendered(true);
    setOpen(true);
  };

  const closePalette = useCallback(() => {
    setOpen(false);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRendered(false);
      return;
    }
    window.setTimeout(() => {
      if (!openRef.current) setRendered(false);
    }, 340);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: close on navigation
  useEffect(() => {
    closePalette();
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closePalette();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        paletteRef.current?.querySelectorAll<HTMLElement>(
          'jelly-button:not([disabled]), a[href], button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
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
  }, [open, closePalette]);

  const activeHref = navItems
    .filter((item) => (item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  const activeItem = navItems.find((item) => item.href === activeHref) ?? navItems[0];
  const ActiveIcon = activeItem ? navIcons[activeItem.href] : Menu;
  const totalAttention = pendingApprovals + memoryReviewCount + needsAttentionCount;

  const badgeTitleFor = (item: NavItem, count: number) =>
    item.href === '/profile' && count > 0
      ? `${count.toLocaleString()} ${count === 1 ? 'memory needs' : 'memories need'} your review`
      : item.href === '/tasks' && count > 0
        ? `${count.toLocaleString()} ${count === 1 ? 'task needs' : 'tasks need'} your attention`
        : item.href === '/approvals' && count > 0
          ? `${count.toLocaleString()} pending ${count === 1 ? 'approval' : 'approvals'}`
          : undefined;

  const renderPrimaryCards = (items: NavItem[]) =>
    items.map((item) => {
      const active = item.href === activeHref;
      const Icon = navIcons[item.href];
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
          data-mobile-touch-target="true"
          aria-current={active ? 'page' : undefined}
          className={`nav-destination-card mobile-touch-target ${
            active ? 'nav-destination-card-active' : ''
          } ${focusRing}`}
        >
          <span className="nav-destination-topline">
            <span className="nav-destination-icon">
              {Icon ? <Icon className="size-4" aria-hidden="true" /> : null}
            </span>
            {count > 0 ? (
              <JellyCountBadge count={count} title={badgeTitleFor(item, count)} />
            ) : active ? (
              <span className="nav-current-chip">Here</span>
            ) : (
              <ChevronRight className="nav-card-arrow size-4" aria-hidden="true" />
            )}
          </span>
          <span className="nav-destination-copy">
            <span className="nav-destination-title">{item.label}</span>
            <span className="nav-destination-description">{navDescriptions[item.href]}</span>
          </span>
        </Link>
      );
    });

  const renderCompactLinks = (items: NavItem[]) =>
    items.map((item) => {
      const active = item.href === activeHref;
      const Icon = navIcons[item.href];
      return (
        <Link
          key={item.href}
          href={item.href}
          data-mobile-touch-target="true"
          aria-current={active ? 'page' : undefined}
          className={`nav-compact-link mobile-touch-target ${
            active ? 'nav-compact-link-active' : ''
          } ${focusRing}`}
        >
          {Icon ? <Icon className="size-4" aria-hidden="true" /> : null}
          <span>{item.label}</span>
        </Link>
      );
    });

  const primaryItems = navItems.filter((item) => !item.utility && !item.system);
  const utilityItems = navItems.filter((item) => item.utility);
  const systemItems = navItems.filter((item) => item.system);
  const systemContainsCurrent = systemItems.some((item) => item.href === activeHref);

  return (
    <>
      <aside className="nav-anchor hidden shrink-0 lg:block">
        <div className="nav-anchor-inner">
          <button
            ref={menuTriggerRef}
            type="button"
            data-mobile-touch-target="true"
            data-open={open}
            aria-label="Open navigation menu"
            aria-expanded={open}
            aria-controls="desktop-nav"
            onClick={openPalette}
            className={`nav-launcher mobile-touch-target ${focusRing}`}
          >
            <span className="nav-launcher-icon">
              {ActiveIcon ? (
                <ActiveIcon className="size-4" aria-hidden="true" />
              ) : (
                <Menu className="size-4" aria-hidden="true" />
              )}
            </span>
            <span className="nav-launcher-copy">
              <span>Navigate</span>
              <strong>{activeItem?.label ?? 'Menu'}</strong>
            </span>
            <ChevronRight className="nav-launcher-arrow size-4" aria-hidden="true" />
            {totalAttention > 0 ? (
              <span className="nav-launcher-badge" aria-hidden="true">
                {formatBadgeCount(totalAttention)}
              </span>
            ) : null}
          </button>
        </div>
      </aside>

      <MobileNavBloom
        navItems={navItems}
        pendingApprovals={pendingApprovals}
        signedIn={signedIn}
        memoryReviewCount={memoryReviewCount}
        needsAttentionCount={needsAttentionCount}
      />

      {rendered ? (
        <div className="nav-overlay fixed inset-0 z-40 hidden lg:block">
          <button
            type="button"
            aria-label="Close navigation menu"
            aria-hidden="true"
            tabIndex={-1}
            onClick={closePalette}
            data-open={open}
            className={`nav-scrim absolute inset-0 ${open ? '' : 'pointer-events-none'}`}
          />
          <div
            ref={paletteRef}
            id="desktop-nav"
            role="dialog"
            aria-modal="true"
            aria-labelledby="desktop-nav-title"
            data-open={open}
            inert={!open}
            onTransitionEnd={(event) => {
              if (event.target === event.currentTarget && !open) setRendered(false);
            }}
            className="nav-palette"
          >
            <div className="nav-palette-header">
              <div className="min-w-0">
                <span id="desktop-nav-title" className={`${microLabelClass} text-muted`}>
                  Navigate
                </span>
                <p className="nav-palette-context truncate">
                  Current place <strong>{activeItem?.label ?? 'Chat'}</strong>
                </p>
              </div>
              <div className="nav-palette-actions">
                <span className="nav-close-control">
                  <JellyIconButton
                    buttonRef={closeButtonRef}
                    onClick={closePalette}
                    label="Close navigation menu"
                  >
                    <X className="size-5" aria-hidden="true" />
                  </JellyIconButton>
                </span>
                <span className="nav-theme-control">
                  <ThemeToggle />
                </span>
              </div>
            </div>

            <div className="nav-palette-scroll scroll-subtle">
              <section aria-labelledby="nav-primary-title">
                <h2 id="nav-primary-title" className={`${microLabelClass} px-1 text-muted`}>
                  Places
                </h2>
                <nav aria-label="Primary navigation" className="nav-destination-grid mt-2">
                  {renderPrimaryCards(primaryItems)}
                </nav>
              </section>

              <section className="mt-5" aria-labelledby="nav-tools-title">
                <h2 id="nav-tools-title" className={`${microLabelClass} px-1 text-muted`}>
                  Tools
                </h2>
                <nav aria-label="Management navigation" className="nav-compact-grid mt-2">
                  {renderCompactLinks(utilityItems)}
                </nav>
              </section>

              {systemItems.length > 0 ? (
                <details
                  className="nav-system-disclosure mt-3"
                  open={systemContainsCurrent || undefined}
                >
                  <summary className={`mobile-touch-target ${focusRing}`}>
                    <span className="nav-system-icon">
                      <Gauge className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <strong>System</strong>
                      <span>Costs, anomalies, and improvements</span>
                    </span>
                    <ChevronRight className="nav-system-arrow size-4" aria-hidden="true" />
                  </summary>
                  <nav aria-label="System navigation" className="nav-system-grid">
                    {renderCompactLinks(systemItems)}
                  </nav>
                </details>
              ) : null}
            </div>

            {signedIn ? (
              <div className="nav-palette-footer">
                <form action={signOutAction}>
                  <button type="submit" className={`nav-sign-out mobile-touch-target ${focusRing}`}>
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
