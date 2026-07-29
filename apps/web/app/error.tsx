'use client';

import { btn } from '@/lib/ui';

/** Route error boundary — friendly, no stack traces or internal detail leaked. */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      <h1 className="text-lg font-semibold text-strong">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted">
        This page hit an unexpected error. The app is still running — try again.
      </p>
      <button type="button" onClick={reset} className={`${btn.primary} mt-5`}>
        Try again
      </button>
    </div>
  );
}
