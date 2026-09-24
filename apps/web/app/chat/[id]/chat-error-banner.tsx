'use client';

import Link from 'next/link';
import type { ChatErrorInfo } from './message-view';

/**
 * The send-failure banner above the composer. The server answers failures with
 * owner-facing copy plus a machine `code` (see chat-turn.ts), and the banner
 * attaches the action that fits the failure: a budget stop links to the Costs
 * page, everything recoverable offers a one-click resend, and Restore draft
 * stays the escape hatch for editing the words first.
 */
export function ChatErrorBanner({
  error,
  canRetry,
  onRetry,
  onRestoreDraft,
  onDismiss,
}: {
  error: ChatErrorInfo;
  /** The failed turn's text is known and the composer is empty. */
  canRetry: boolean;
  onRetry: () => void;
  onRestoreDraft: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className="pointer-events-auto mb-2 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
    >
      <span>{error.message}</span>
      <span className="flex shrink-0 items-center gap-2">
        {error.code === 'budget_exhausted' ? (
          <Link
            href="/costs"
            className="text-xs font-medium underline underline-offset-2 hover:no-underline"
          >
            Open Costs
          </Link>
        ) : null}
        {canRetry ? (
          <>
            <button
              type="button"
              onClick={onRetry}
              className="text-xs font-medium underline underline-offset-2 hover:no-underline"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={onRestoreDraft}
              className="text-xs font-medium underline underline-offset-2 hover:no-underline"
            >
              Restore draft
            </button>
          </>
        ) : null}
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs underline underline-offset-2 hover:no-underline"
        >
          Dismiss
        </button>
      </span>
    </div>
  );
}
