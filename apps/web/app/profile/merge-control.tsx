'use client';

import { useState, useTransition } from 'react';
import { mergeContactAction } from '@/app/profile/actions';
import { btnSm, selectClass } from '@/lib/ui';

/** Fold a duplicate person into another contact (facts move, duplicate disappears). */
export function MergeControl({
  contactId,
  options,
  suggested,
}: {
  contactId: string;
  options: Array<{ id: string; label: string }>;
  suggested?: { targetId: string; reason: string };
}) {
  const [targetId, setTargetId] = useState(suggested?.targetId ?? '');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const targetLabel = options.find((o) => o.id === targetId)?.label ?? '';

  const merge = () => {
    setError(null);
    startTransition(async () => {
      const result = await mergeContactAction(contactId, targetId);
      if (result.error) {
        setError(result.error);
        setConfirming(false);
      }
    });
  };

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {suggested ? (
        <span
          className="rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
          title={`Possible duplicate: ${suggested.reason}`}
        >
          possible duplicate
        </span>
      ) : null}
      <select
        aria-label="Merge into"
        value={targetId}
        disabled={pending}
        onChange={(e) => {
          setTargetId(e.target.value);
          setConfirming(false);
          setError(null);
        }}
        className={`${selectClass} min-w-44`}
      >
        <option value="">merge into…</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
            {suggested?.targetId === o.id ? ' — suggested' : ''}
          </option>
        ))}
      </select>
      {targetId ? (
        confirming ? (
          <button type="button" disabled={pending} onClick={merge} className={btnSm.danger}>
            {pending ? 'Merging…' : `Confirm merge into ${targetLabel}`}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              setConfirming(true);
              setError(null);
            }}
            className={btnSm.outline}
          >
            Merge
          </button>
        )
      ) : null}
      {error ? (
        <span role="alert" className="w-full text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : null}
    </span>
  );
}
