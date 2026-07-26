'use client';

import { useState, useTransition } from 'react';
import { JellyInput, JellyTextarea } from '@/app/jelly-form-controls';
import { JellyButton } from '@/app/jelly-icon-button';
import { updateAgentSettings } from '@/app/settings/actions';
import { labelClass } from '@/lib/ui';

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
    <div className="flex min-w-0 flex-col gap-4">
      <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <label htmlFor="agent-timezone" className="flex min-w-0 flex-col gap-1.5">
          <span className={labelClass}>Timezone</span>
          <JellyInput
            id="agent-timezone"
            ariaLabel="Timezone"
            label="Timezone"
            value={timezone}
            onValueChange={(next) => {
              setTimezone(next);
              onChange();
            }}
            className="w-full"
            placeholder="Atlantic/Reykjavik"
            size="md"
          />
        </label>
        <label htmlFor="agent-locale" className="flex min-w-0 flex-col gap-1.5">
          <span className={labelClass}>Locale</span>
          <JellyInput
            id="agent-locale"
            ariaLabel="Locale"
            label="Locale"
            value={locale}
            onValueChange={(next) => {
              setLocale(next);
              onChange();
            }}
            className="w-full"
            placeholder="en"
            size="md"
          />
        </label>
      </div>
      <label htmlFor="agent-signature" className="flex min-w-0 flex-col gap-1.5">
        <span className={labelClass}>Email signature</span>
        <JellyTextarea
          id="agent-signature"
          ariaLabel="Email signature"
          label="Email signature"
          value={signature}
          onValueChange={(next) => {
            setSignature(next);
            onChange();
          }}
          rows={3}
          placeholder="Appended to email the assistant sends on your behalf"
          className="w-full"
          size="md"
        />
      </label>
      <div className="flex items-center gap-2">
        <JellyButton
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await updateAgentSettings({ timezone, locale, signature });
              if (result.error) setError(result.error);
              else setSaved(true);
            })
          }
          tone="primary"
          busy={pending}
        >
          {pending ? 'Saving…' : 'Save changes'}
        </JellyButton>
        {saved && !pending ? (
          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Saved</span>
        ) : null}
        {error ? (
          <span role="alert" className="text-xs text-red-600 dark:text-red-400">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}
