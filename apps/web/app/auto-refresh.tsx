'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Periodically refresh the current RSC route so dashboards (approvals, activity)
 * pick up new state without a manual reload. Pauses when the tab is hidden or a
 * form is mid-submit, so it never clobbers an in-flight action or burns cycles
 * in the background. Mount once per page.
 */
export function AutoRefresh({ intervalMs = 12_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      // Don't refresh while the owner is filling in or submitting a form.
      if (document.querySelector('form [aria-busy="true"], form button[disabled]')) return;
      if (
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA'
      ) {
        return;
      }
      router.refresh();
    };
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);
  return null;
}
