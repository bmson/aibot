'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { useJellyReady } from './jelly-ready';

export interface JellyNavTab {
  href: string;
  label: string;
  value: string;
}

function JellySegment({ label, value }: { label: string; value: string }) {
  return createElement(
    'jelly-segment',
    {
      ref: (element: HTMLElement | null) => element?.setAttribute('value', value),
    },
    label,
  );
}

/**
 * URL-backed tabs retain native links until Jelly is registered. The outer
 * viewport owns intentional horizontal overflow, so full labels remain
 * readable and keyboard behavior stays with the segmented control.
 */
export function JellyNavTabs({
  className = '',
  items,
  label,
  value,
}: {
  className?: string;
  items: readonly JellyNavTab[];
  label: string;
  value: string;
}) {
  const router = useRouter();
  const ready = useJellyReady('jelly-segmented');
  const segmentedRef = useRef<HTMLElement | null>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  const [scrollState, setScrollState] = useState({
    overflow: false,
    atStart: true,
    atEnd: true,
  });
  const measureOverflow = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const overflow = viewport.scrollWidth - viewport.clientWidth > 1;
    setScrollState({
      overflow,
      atStart: viewport.scrollLeft <= 1,
      atEnd: viewport.scrollLeft + viewport.clientWidth >= viewport.scrollWidth - 1,
    });
  }, []);

  useEffect(() => {
    for (const item of items) router.prefetch(item.href);
  }, [items, router]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(measureOverflow);
    observer.observe(viewport);
    const content = ready ? viewport.querySelector('.app-jelly-tabs') : viewport.firstElementChild;
    if (content) observer.observe(content);
    measureOverflow();
    return () => observer.disconnect();
  }, [measureOverflow, ready]);

  useEffect(() => {
    if (!ready) return;
    const element = segmentedRef.current;
    if (!element) return;
    const navigate = (event: Event) => {
      const nextValue = (event as CustomEvent<{ value?: string }>).detail?.value;
      if (!nextValue) return;
      const next = items.find((item) => item.value === nextValue);
      if (next && next.value !== value) router.push(next.href);
    };
    element.addEventListener('change', navigate);
    return () => element.removeEventListener('change', navigate);
  }, [items, ready, router, value]);

  return (
    <nav
      ref={viewportRef}
      aria-label={label}
      className={`jelly-tabs-viewport ${className}`.trim()}
      data-ready={ready || undefined}
      data-overflow={scrollState.overflow || undefined}
      data-at-start={scrollState.atStart || undefined}
      data-at-end={scrollState.atEnd || undefined}
      onScroll={measureOverflow}
    >
      <div className="jelly-tabs-track">
        {ready
          ? createElement(
              'jelly-segmented',
              {
                'aria-label': label,
                className: 'app-jelly-tabs',
                label,
                ref: segmentedRef,
                roles: 'tablist',
                size: 'small',
                value,
              },
              items.map((item) =>
                createElement(JellySegment, {
                  key: item.value,
                  label: item.label,
                  value: item.value,
                }),
              ),
            )
          : items.map((item) => (
              <Link
                key={item.value}
                href={item.href}
                aria-current={item.value === value ? 'page' : undefined}
                className={`mobile-touch-target inline-flex items-center rounded-lg px-3 text-[13px] font-semibold whitespace-nowrap ${
                  item.value === value ? 'bg-raised text-strong shadow-sm' : 'text-muted'
                }`}
              >
                {item.label}
              </Link>
            ))}
      </div>
    </nav>
  );
}
