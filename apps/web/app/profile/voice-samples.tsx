'use client';

import { useState, useTransition } from 'react';
import { purgeVoiceSamplesAction } from '@/app/profile/actions';
import {
  btn,
  CountBadge,
  cardBodyClass,
  cardFooterClass,
  cardHeaderClass,
  cardShellClass,
  fileInputClass,
  inputClass,
  MetaLine,
} from '@/lib/ui';

/** Plain-serializable view built in page.tsx. */
export interface VoiceImportView {
  source: string;
  status: string;
  itemsTotal: number | null;
  itemsProcessed: number;
  memoriesSaved: number;
  taskId: string | null;
  error: string | null;
}

const registerOptions: Array<{ value: string; label: string }> = [
  { value: 'email_casual', label: 'Casual email' },
  { value: 'email_professional', label: 'Professional email' },
  { value: 'sms', label: 'Text messages' },
  { value: 'chat', label: 'Chat' },
];

const statusLabels: Record<string, string> = {
  pending: 'Queued',
  running: 'Learning',
  done: 'Done',
  failed: 'Needs attention',
  purged: 'Removed',
};

/**
 * Voice-sample corpus controls: upload a batch of your own sent mail to teach
 * the assistant your writing style faster, see how many samples it has, and
 * clear the auto-captured + uploaded ones.
 */
export function VoiceSamplesPanel({
  total,
  auto,
  uploaded,
  imports,
}: {
  total: number;
  auto: number;
  uploaded: number;
  imports: VoiceImportView[];
}) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const purgeable = auto + uploaded;

  return (
    <section className={`${cardShellClass} mt-6`}>
      <div className={cardBodyClass}>
        <div className={cardHeaderClass}>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold">Your writing voice</h2>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">
              The assistant learns from your own sent messages so its drafts sound more like you.
              Forwarded and quoted text is skipped.
            </p>
          </div>
          <CountBadge>
            {total} {total === 1 ? 'sample' : 'samples'}
          </CountBadge>
        </div>
        {/* The pill already carries the total — the breakdown is one quiet
            line, not a grid of three boxed figures. */}
        {total > 0 ? (
          <MetaLine
            segments={[
              `${auto.toLocaleString()} learned from your sent mail`,
              `${uploaded.toLocaleString()} uploaded`,
            ]}
          />
        ) : null}

        {/* Upload */}
        <form
          action="/api/import/upload"
          method="post"
          encType="multipart/form-data"
          className="grid gap-3 rounded-xl bg-sunken/55 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
        >
          <input type="hidden" name="voice" value="1" />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-strong">Add sent messages</p>
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-3">
              <input
                type="file"
                name="file"
                required
                accept=".mbox,.txt,.json,.md,text/plain,application/json"
                className={fileInputClass}
              />
              <label className="flex items-center gap-1.5 text-xs text-muted">
                Style
                <select name="register" defaultValue="email_casual" className={inputClass}>
                  {registerOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted">
              Gmail Takeout <code>.mbox</code>, plain text, or JSON · up to 25MB
            </p>
          </div>
          <button type="submit" className={btn.primary}>
            Upload sent mail
          </button>
        </form>

        {/* In-flight / failed voice imports */}
        {imports.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {imports.map((imp) => (
              <div key={imp.source} className="rounded-xl bg-sunken/55 px-3 py-2.5 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{statusLabels[imp.status] ?? imp.status}</span>
                  <span className="text-muted">
                    {imp.memoriesSaved} {imp.memoriesSaved === 1 ? 'sample' : 'samples'}
                  </span>
                </div>
                {imp.itemsTotal ? (
                  <p className="mt-1 text-muted">
                    {imp.itemsProcessed} of {imp.itemsTotal} messages
                  </p>
                ) : null}
                {imp.error ? (
                  <p className="mt-1 text-red-600 dark:text-red-400">{imp.error}</p>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* Purge */}
      {purgeable > 0 ? (
        <footer className={cardFooterClass}>
          {confirming ? (
            <>
              <button
                type="button"
                disabled={pending}
                onClick={() => startTransition(() => purgeVoiceSamplesAction())}
                className={btn.danger}
              >
                Clear {purgeable} {purgeable === 1 ? 'sample' : 'samples'}
              </button>
              <button type="button" onClick={() => setConfirming(false)} className={btn.outline}>
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className={btn.dangerOutline}
              title="Delete the auto-learned and uploaded samples; the distilled voice profile is kept"
            >
              Clear learned & uploaded samples
            </button>
          )}
        </footer>
      ) : null}
    </section>
  );
}
