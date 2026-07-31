'use client';

import {
  ArrowLeft,
  Brain,
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
import { usePathname, useRouter } from 'next/navigation';
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
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

interface BloomPosition {
  x: number;
  y: number;
}

type BloomEntry =
  | {
      key: string;
      label: string;
      icon: LucideIcon;
      kind: 'route';
      href: string;
      count: number;
    }
  | {
      key: 'more';
      label: 'More';
      icon: LucideIcon;
      kind: 'more';
      count: 0;
    }
  | {
      key: 'back';
      label: 'Back';
      icon: LucideIcon;
      kind: 'back';
      count: 0;
    }
  | {
      key: 'sign-out';
      label: 'Sign out';
      icon: LucideIcon;
      kind: 'sign-out';
      count: 0;
    };

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

const bloomPositionSets: Record<number, BloomPosition[]> = {
  1: [{ x: 0, y: -116 }],
  2: [
    { x: -58, y: -100 },
    { x: 58, y: -100 },
  ],
  3: [
    { x: -92, y: -70 },
    { x: 0, y: -126 },
    { x: 92, y: -70 },
  ],
  4: [
    { x: -112, y: -56 },
    { x: -42, y: -126 },
    { x: 42, y: -126 },
    { x: 112, y: -56 },
  ],
  5: [
    { x: -124, y: -46 },
    { x: -76, y: -110 },
    { x: 0, y: -142 },
    { x: 76, y: -110 },
    { x: 124, y: -46 },
  ],
  6: [
    { x: -132, y: -44 },
    { x: -96, y: -102 },
    { x: -34, y: -139 },
    { x: 34, y: -139 },
    { x: 96, y: -102 },
    { x: 132, y: -44 },
  ],
  7: [
    { x: -132, y: -38 },
    { x: -108, y: -94 },
    { x: -56, y: -136 },
    { x: 0, y: -153 },
    { x: 56, y: -136 },
    { x: 108, y: -94 },
    { x: 132, y: -38 },
  ],
  8: [
    { x: -132, y: -36 },
    { x: -116, y: -91 },
    { x: -68, y: -132 },
    { x: -24, y: -154 },
    { x: 24, y: -154 },
    { x: 68, y: -132 },
    { x: 116, y: -91 },
    { x: 132, y: -36 },
  ],
};

function positionsFor(count: number): BloomPosition[] {
  return bloomPositionSets[Math.min(8, Math.max(1, count))] ?? bloomPositionSets[8];
}

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
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [layer, setLayer] = useState<'primary' | 'secondary'>('primary');
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const openRef = useRef(open);
  const signOutFormRef = useRef<HTMLFormElement>(null);
  const ignoreNextClickRef = useRef(false);
  const gestureRef = useRef({
    pointerId: -1,
    startX: 0,
    startY: 0,
    moved: false,
    wasOpen: false,
  });

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const openBloom = useCallback(() => {
    setLayer('primary');
    setHighlightedKey(null);
    setRendered(true);
    setOpen(true);
  }, []);

  const closeBloom = useCallback(() => {
    setOpen(false);
    setHighlightedKey(null);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRendered(false);
      return;
    }
    window.setTimeout(() => {
      if (!openRef.current) setRendered(false);
    }, 260);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: close on navigation
  useEffect(() => {
    closeBloom();
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeBloom();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      triggerRef.current?.focus();
    };
  }, [open, closeBloom]);

  const activeHref = navItems
    .filter((item) => (item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  const activeItem = navItems.find((item) => item.href === activeHref) ?? navItems[0];
  const ActiveIcon = activeItem ? navIcons[activeItem.href] : Menu;
  const totalAttention = pendingApprovals + memoryReviewCount + needsAttentionCount;
  const primaryItems = navItems.filter((item) => !item.utility && !item.system);
  const utilityItems = navItems.filter((item) => item.utility);
  const systemItems = navItems.filter((item) => item.system);

  const primaryEntries: BloomEntry[] = primaryItems.map((item) => ({
    key: item.href,
    label: item.label,
    icon: navIcons[item.href] ?? Menu,
    kind: 'route',
    href: item.href,
    count: badgeCountFor(
      item.href,
      pendingApprovals,
      memoryReviewCount,
      needsAttentionCount,
    ),
  }));
  if (utilityItems.length > 0 || systemItems.length > 0 || signedIn) {
    primaryEntries.push({
      key: 'more',
      label: 'More',
      icon: MoreHorizontal,
      kind: 'more',
      count: 0,
    });
  }

  const secondaryEntries: BloomEntry[] = [
    { key: 'back', label: 'Back', icon: ArrowLeft, kind: 'back', count: 0 },
    ...[...utilityItems, ...systemItems].map((item) => ({
      key: item.href,
      label: item.label,
      icon: navIcons[item.href] ?? Menu,
      kind: 'route' as const,
      href: item.href,
      count: 0,
    })),
  ];
  if (signedIn) {
    secondaryEntries.push({
      key: 'sign-out',
      label: 'Sign out',
      icon: LogOut,
      kind: 'sign-out',
      count: 0,
    });
  }

  const activateEntry = useCallback(
    (entry: BloomEntry) => {
      if (entry.kind === 'more') {
        setLayer('secondary');
        setHighlightedKey(null);
        return;
      }
      if (entry.kind === 'back') {
        setLayer('primary');
        setHighlightedKey(null);
        return;
      }
      if (entry.kind === 'sign-out') {
        signOutFormRef.current?.requestSubmit();
        return;
      }
      closeBloom();
      router.push(entry.href);
    },
    [closeBloom, router],
  );

  const currentEntries = layer === 'primary' ? primaryEntries : secondaryEntries;

  const nearestEntry = (clientX: number, clientY: number): BloomEntry | undefined => {
    let nearest: { entry: BloomEntry; distance: number } | undefined;
    for (const entry of currentEntries) {
      const element = itemRefs.current.get(entry.key);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      const distance = Math.hypot(
        clientX - (rect.left + rect.width / 2),
        clientY - (rect.top + rect.height / 2),
      );
      if (!nearest || distance < nearest.distance) nearest = { entry, distance };
    }
    return nearest && nearest.distance <= 46 ? nearest.entry : undefined;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse') return;
    ignoreNextClickRef.current = true;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      wasOpen: open,
    };
    if (!open) openBloom();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (gestureRef.current.pointerId !== event.pointerId) return;
    const movement = Math.hypot(
      event.clientX - gestureRef.current.startX,
      event.clientY - gestureRef.current.startY,
    );
    if (movement > 8) gestureRef.current.moved = true;
    const nearest = nearestEntry(event.clientX, event.clientY);
    setHighlightedKey(nearest?.key ?? null);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (gestureRef.current.pointerId !== event.pointerId) return;
    event.preventDefault();
    const selected = nearestEntry(event.clientX, event.clientY);
    if (selected) {
      activateEntry(selected);
    } else if (gestureRef.current.moved || gestureRef.current.wasOpen) {
      closeBloom();
    }
    gestureRef.current.pointerId = -1;
    setHighlightedKey(null);
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (gestureRef.current.pointerId !== event.pointerId) return;
    gestureRef.current.pointerId = -1;
    setHighlightedKey(null);
    closeBloom();
  };

  const renderEntry = (
    entry: BloomEntry,
    position: BloomPosition,
    index: number,
    visible: boolean,
  ) => {
    const Icon = entry.icon;
    const active = entry.kind === 'route' && entry.href === activeHref;
    const registerElement = (element: HTMLElement | null) => {
      if (element) itemRefs.current.set(entry.key, element);
      else itemRefs.current.delete(entry.key);
    };
    const commonProps = {
      'data-bloom-key': entry.key,
      'data-visible': visible,
      'data-highlighted': highlightedKey === entry.key,
      'data-current': active,
      'aria-hidden': !visible,
      tabIndex: visible ? undefined : -1,
      style: {
        '--bloom-x': `${position.x}px`,
        '--bloom-y': `${position.y}px`,
        '--bloom-delay': `${index * 22}ms`,
      } as CSSProperties,
      className: `nav-bloom-item mobile-touch-target ${focusRing}`,
    };
    const contents = (
      <>
        <span className="nav-bloom-icon">
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <span className="nav-bloom-label">{entry.label}</span>
        {entry.count > 0 ? (
          <span className="nav-bloom-count" aria-label={`${entry.count} items need attention`}>
            {formatBadgeCount(entry.count)}
          </span>
        ) : null}
      </>
    );
    const interactionProps = {
      onMouseEnter: () => setHighlightedKey(entry.key),
      onMouseLeave: () => setHighlightedKey(null),
      onFocus: () => setHighlightedKey(entry.key),
      onBlur: () => setHighlightedKey(null),
    };

    if (entry.kind === 'route') {
      return (
        <Link
          key={entry.key}
          ref={registerElement}
          {...commonProps}
          {...interactionProps}
          href={entry.href}
          aria-current={active ? 'page' : undefined}
          onClick={closeBloom}
        >
          {contents}
        </Link>
      );
    }

    return (
      <button
        key={entry.key}
        ref={registerElement}
        {...commonProps}
        {...interactionProps}
        type="button"
        onClick={() => activateEntry(entry)}
      >
        {contents}
      </button>
    );
  };

  const primaryPositions = positionsFor(primaryEntries.length);
  const secondaryPositions = positionsFor(secondaryEntries.length);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-chat={pathname.startsWith('/chat')}
        data-attention={totalAttention > 0}
        aria-label="Open navigation menu"
        aria-expanded={open}
        aria-controls="mobile-nav"
        onClick={() => {
          if (ignoreNextClickRef.current) {
            ignoreNextClickRef.current = false;
            return;
          }
          if (open) closeBloom();
          else openBloom();
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        className={`nav-bloom-trigger mobile-touch-target lg:hidden ${focusRing}`}
      >
        <span className="nav-bloom-trigger-orbit" aria-hidden="true" />
        {ActiveIcon ? (
          <ActiveIcon className="size-5" aria-hidden="true" />
        ) : (
          <Menu className="size-5" aria-hidden="true" />
        )}
        {totalAttention > 0 ? (
          <span className="nav-bloom-trigger-count" aria-label={`${totalAttention} items need attention`}>
            {formatBadgeCount(totalAttention)}
          </span>
        ) : null}
      </button>

      {rendered ? (
        <div
          ref={dialogRef}
          id="mobile-nav"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mobile-nav-title"
          data-open={open}
          data-layer={layer}
          inert={!open}
          className="nav-bloom-dialog lg:hidden"
        >
          <h2 id="mobile-nav-title" className="sr-only">
            Navigation
          </h2>
          <button
            type="button"
            aria-label="Close navigation menu"
            aria-hidden="true"
            tabIndex={-1}
            onClick={closeBloom}
            className="nav-bloom-scrim"
          />
          <div className="nav-bloom-stage" aria-label="Navigation destinations">
            <button
              ref={closeRef}
              type="button"
              aria-label="Close navigation menu"
              onClick={closeBloom}
              className={`nav-bloom-center mobile-touch-target ${focusRing}`}
            >
              <X className="size-5" aria-hidden="true" />
            </button>
            <p className="nav-bloom-instruction" aria-hidden="true">
              {layer === 'primary' ? 'Slide and release' : 'More places'}
            </p>
            {primaryEntries.map((entry, index) =>
              renderEntry(
                entry,
                primaryPositions[index] ?? primaryPositions[0],
                index,
                open && layer === 'primary',
              ),
            )}
            {secondaryEntries.map((entry, index) =>
              renderEntry(
                entry,
                secondaryPositions[index] ?? secondaryPositions[0],
                index,
                open && layer === 'secondary',
              ),
            )}
          </div>
          {signedIn ? <form ref={signOutFormRef} action={signOutAction} /> : null}
        </div>
      ) : null}
    </>
  );
}
