'use client';

import { useState, useTransition } from 'react';
import { mergeContactAction } from '@/app/profile/actions';

/** Fold a duplicate person into another contact (facts move, duplicate disappears). */
export function MergeControl({
  contactId,
  options,
}: {
  contactId: string;
  options: Array<{ id: string; label: string }>;
}) {
  const [targetId, setTargetId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  const targetLabel = options.find((o) => o.id === targetId)?.label ?? '';

  return (
    <span className="flex items-center gap-1.5">
      <select
        aria-label="Merge into"
        value={targetId}
        disabled={pending}
        onChange={(e) => {
          setTargetId(e.target.value);
          setConfirming(false);
        }}
        className="rounded-md border border-zinc-300 bg-white px-1.5 py-0.5 text-[11px] dark:border-zinc-700 dark:bg-zinc-900"
      >
        <option value="">merge into…</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {targetId ? (
        confirming ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => startTransition(() => mergeContactAction(contactId, targetId))}
            className="rounded-md bg-red-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {pending ? 'Merging…' : `Confirm merge into ${targetLabel}`}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-md border border-zinc-300 px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Merge
          </button>
        )
      ) : null}
    </span>
  );
}
