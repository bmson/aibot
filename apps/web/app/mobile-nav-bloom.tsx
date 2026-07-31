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
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
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

const navDescriptions: Record<string, string> = {
  '/chat': 'Talk and work with your assistant',
  '/approvals': 'Review decisions waiting on you',
  '/tasks': 'See active and recent work',
  '/goals': 'Manage longer-term outcomes',
  '/profile': 'Review what the assistant remembers',
  '/documents': 'Browse files and generated documents',
  '/skills': 'Manage connected capabilities',
  '/settings': 'Preferences and configuration',
  '/costs': 'Usage and spending',
  '/anomalies': 'Unexpected system behavior',
  '/improvements': 'Suggested assistant improvements',
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
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
  const [overComposer, setOverComposer] = useState(false);
  const [triggerStyle, setTriggerStyle] = useState<CSSProperties>();
  const [panelStyle, setPanelStyle] = useState<CSSProperties>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const signOutFormRef = useRef<HTMLFormElement>(null);
  const openRef = useRef(open);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const updateTriggerPosition = useCallback(() => {
    if (window.innerWidth >= 1024) return;
    const composer = document.querySelector<HTMLElement>('[data-testid="chat-composer-surface"]');
    if (!composer) {
      setOverComposer(false);
      setTriggerStyle(undefined);
      return;
    }

    const rect = composer.getBoundingClientRect();
    setOverComposer(true);
    setTriggerStyle({
      top: clamp(rect.top - 18, 12, window.innerHeight - 56),
      left: clamp(rect.left + 10, 12, window.innerWidth - 56),
      right: 'auto',
      bottom: 'auto',
    });
  }, []);

  const updatePanelPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 24);
    setPanelStyle({
      width,
      left: clamp(rect.left, 12, window.innerWidth - width - 12),
      bottom: Math.max(12, window.innerHeight - rect.top + 8),
      maxHeight: Math.max(260, rect.top - 24),
    });
  }, []);

  useEffect(() => {
    const update = () => updateTriggerPosition();
    update();
    const frame = window.requestAnimationFrame(update);
    const delayed = window.setTimeout(update, 240);
    const viewport = window.visualViewport;
    window.addEventListener('resize', update);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);

    const composer = document.querySelector<HTMLElement>('[data-testid="chat-composer-surface"]');
    const resizeObserver = composer ? new ResizeObserver(update) : undefined;
    if (composer) resizeObserver?.observe(composer);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(delayed);
      window.removeEventListener('resize', update);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      resizeObserver?.disconnect();
    };
  }, [pathname, updateTriggerPosition]);

  const openMenu = useCallback(() => {
    setLayer('primary');
    setRendered(true);
    window.requestAnimationFrame(() => {
      updatePanelPosition();
      setOpen(true);
    });
  }, [updatePanelPosition]);

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

  useEffect(() => {
    if (openRef.current) closeMenu();
  }, [pathname, closeMenu]);

  useEffect(() => {
    if (!open) return;
    updatePanelPosition();
    const viewport = window.visualViewport;
    const reposition = () => updatePanelPosition();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => {
        if (element.tabIndex < 0 || element.getAttribute('aria-hidden') === 'true') return false;
        return typeof element.checkVisibility === 'function'
          ? element.checkVisibility()
          : element.getClientRects().length > 0;
      });
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

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', reposition);
    viewport?.addEventListener('resize', reposition);
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', reposition);
      viewport?.removeEventListener('resize', reposition);
      triggerRef.current?.focus();
    };
  }, [open, closeMenu, updatePanelPosition]);

  const activeHref = navItems
    .filter((item) => (item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  const activeItem = navItems.find((item) => item.href === activeHref) ?? navItems[0];
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
        onClick={closeMenu}
        className={`nav-mobile-menu-row mobile-touch-target ${focusRing}`}
      >
        <span className="nav-mobile-menu-icon">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <span className="nav-mobile-menu-copy">
          <strong>{item.label}</strong>
          <span>{navDescriptions[item.href]}</span>
        </span>
        {count > 0 ? (
          <span className="nav-mobile-menu-count" aria-label={`${count} items need attention`}>
            {formatBadgeCount(count)}
          </span>
        ) : active ? (
          <Check className="size-4 text-accent" aria-label="Current page" />
        ) : null}
      </Link>
    );
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        style={triggerStyle}
        data-over-composer={overComposer}
        data-attention={totalAttention > 0}
        aria-label="Open navigation menu"
        aria-expanded={open}
        aria-controls="mobile-nav"
        onClick={() => {
          if (open) closeMenu();
          else openMenu();
        }}
        className={`nav-mobile-menu-trigger mobile-touch-target lg:hidden ${focusRing}`}
      >
        <Menu className="size-4.5" aria-hidden="true" />
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
          <button
            type="button"
            aria-label="Close navigation menu"
            aria-hidden="true"
            tabIndex={-1}
            onClick={closeMenu}
            className="nav-mobile-menu-scrim"
          />
          <div
            ref={panelRef}
            style={panelStyle}
            data-open={open}
            data-layer={layer}
            onTransitionEnd={(event) => {
              if (event.target === event.currentTarget && !open) setRendered(false);
            }}
            className="nav-mobile-menu-panel"
          >
            <header className="nav-mobile-menu-header">
              <div className="min-w-0">
                <p id="mobile-nav-title">Menu</p>
                <strong className="truncate">{activeItem?.label ?? 'Chat'}</strong>
              </div>
              <button
                ref={closeRef}
                type="button"
                aria-label="Close navigation menu"
                onClick={closeMenu}
                className={`nav-mobile-menu-close mobile-touch-target ${focusRing}`}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </header>

            <div className="nav-mobile-menu-scroll scroll-subtle">
              <div data-visible={layer === 'primary'} inert={layer !== 'primary'}>
                <nav aria-label="Primary navigation" className="nav-mobile-menu-list">
                  {primaryItems.map(renderNavItem)}
                  {secondaryItems.length > 0 || signedIn ? (
                    <button
                      type="button"
                      onClick={() => {
                        setLayer('secondary');
                        window.requestAnimationFrame(() => backRef.current?.focus());
                      }}
                      className={`nav-mobile-menu-row mobile-touch-target ${focusRing}`}
                    >
                      <span className="nav-mobile-menu-icon">
                        <MoreHorizontal className="size-4" aria-hidden="true" />
                      </span>
                      <span className="nav-mobile-menu-copy">
                        <strong>More</strong>
                        <span>Documents, skills, settings, and system</span>
                      </span>
                    </button>
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
                <nav aria-label="More navigation" className="nav-mobile-menu-list">
                  {secondaryItems.map(renderNavItem)}
                  {signedIn ? (
                    <button
                      type="button"
                      onClick={() => signOutFormRef.current?.requestSubmit()}
                      className={`nav-mobile-menu-row mobile-touch-target ${focusRing}`}
                    >
                      <span className="nav-mobile-menu-icon">
                        <LogOut className="size-4" aria-hidden="true" />
                      </span>
                      <span className="nav-mobile-menu-copy">
                        <strong>Sign out</strong>
                        <span>End this session</span>
                      </span>
                    </button>
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
