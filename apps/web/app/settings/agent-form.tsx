'use client';

import { useState, useTransition } from 'react';
import { updateAgentSettings } from '@/app/settings/actions';
import { btn, inputClass, labelClass } from '@/lib/ui';

/** Timezone/locale/signature editor with Saving…/Saved ✓/error feedback. */
export function AgentForm({
  initial,
}: {
  initial: { timezone: string; locale: string; signature: string };
}) {
  const [timezone, setTimezone] = useState(initial.timezone);
  const [locale, setLocale] = useState(initial.locale);
  const [signature, setSignature] = useState(initial.signature);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onChange = () => {
    setSaved(false);
    setError(null);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Timezone</span>
          <input
            type="text"
            value={timezone}
            onChange={(e) => {
              setTimezone(e.target.value);
              onChange();
            }}
            className={`${inputClass} w-56`}
            placeholder="Atlantic/Reykjavik"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Locale</span>
          <input
            type="text"
            value={locale}
            onChange={(e) => {
              setLocale(e.target.value);
              onChange();
            }}
            className={`${inputClass} w-24`}
            placeholder="en"
          />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Signature (appended to outbound email)</span>
        <textarea
          value={signature}
          onChange={(e) => {
            setSignature(e.target.value);
            onChange();
          }}
          rows={3}
          className={`${inputClass} max-w-xl`}
        />
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await updateAgentSettings({ timezone, locale, signature });
              if (result.error) setError(result.error);
              else setSaved(true);
            })
          }
          className={btn.outline}
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
        {saved && !pending ? (
          <span className="text-2xs font-medium text-emerald-600 dark:text-emerald-400">
            Saved ✓
          </span>
        ) : null}
        {error ? <span className="text-2xs text-red-600 dark:text-red-400">{error}</span> : null}
      </div>
    </div>
  );
}
