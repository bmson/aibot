'use client';

import { useState, useTransition } from 'react';
import { purgeVoiceSamplesAction } from '@/app/profile/actions';
import { btn, inputClass } from '@/lib/ui';

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
    <section className="mt-6 rounded-2xl bg-raised p-5 shadow-[0_1px_2px_rgb(23_25_35/0.06)]">
      <h2 className="flex items-baseline gap-2 text-[15px] font-semibold">
        Your writing voice
        <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-2xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          {total} {total === 1 ? 'sample' : 'samples'}
        </span>
      </h2>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
        The assistant mirrors how you write when it drafts messages for you. It already learns a
        little from the mail you send it; upload a batch of your own sent messages to teach it
        faster. Only your own words are kept — forwarded and quoted text is skipped.
      </p>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
        {auto} learned automatically · {uploaded} uploaded
      </p>

      {/* Upload */}
      <form
        action="/api/import/upload"
        method="post"
        encType="multipart/form-data"
        className="mt-3 flex flex-col items-start gap-3"
      >
        <input type="hidden" name="voice" value="1" />
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="file"
            name="file"
            required
            accept=".mbox,.txt,.json,.md,text/plain,application/json"
            className="text-[13px] text-muted file:mr-3 file:h-9 file:rounded-lg file:border file:border-edge file:bg-raised file:px-3 file:text-[13px] file:font-medium file:text-strong hover:file:bg-sunken"
          />
          <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
            Style
            <select name="register" defaultValue="email_casual" className={inputClass}>
              {registerOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={btn.primary}>
            Upload sent mail
          </button>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-500">
          A Gmail Takeout <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">.mbox</code>{' '}
          of your Sent mail works well, as does a plain text or JSON export. Up to 25MB.
        </p>
      </form>

      {/* In-flight / failed voice imports */}
      {imports.length > 0 ? (
        <div className="mt-3 flex flex-col gap-1.5">
          {imports.map((imp) => (
            <div
              key={imp.source}
              className="flex flex-wrap items-center gap-2 rounded-xl bg-sunken/55 px-3 py-2 text-xs"
            >
              <span className="font-medium">{statusLabels[imp.status] ?? imp.status}</span>
              <span className="text-zinc-500 dark:text-zinc-500">
                {imp.memoriesSaved} {imp.memoriesSaved === 1 ? 'sample' : 'samples'}
                {imp.itemsTotal ? ` · ${imp.itemsProcessed}/${imp.itemsTotal} messages` : ''}
              </span>
              {imp.error ? (
                <span className="text-red-600 dark:text-red-400">{imp.error}</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {/* Purge */}
      {purgeable > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
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
        </div>
      ) : null}
    </section>
  );
}
