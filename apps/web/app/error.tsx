'use client';

import { btn, PageHeader, PageShell } from '@/lib/ui';

/** Route error boundary — friendly, no stack traces or internal detail leaked. */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <PageShell size="reading" className="pt-10">
      <PageHeader
        title="Something went wrong"
        intro="This page hit an unexpected error. The app is still running — try again."
        actions={
          <button type="button" onClick={reset} className={btn.primary}>
            Try again
          </button>
        }
      />
    </PageShell>
  );
}
