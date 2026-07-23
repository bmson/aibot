'use client';

import { useState, useTransition } from 'react';
import { updateContactRelationship } from '@/app/profile/actions';

/**
 * Relationship editor with explicit save feedback: Saving… while the server
 * action runs, then a Saved ✓ flash. Saving a non-empty relationship also
 * vouches for the contact (unknown → known), so the chip updates on reload.
 */
export function RelationshipForm({ contactId, initial }: { contactId: string; initial: string }) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <span className="flex items-center gap-1.5">
      <input
        type="text"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setSaved(false);
        }}
        placeholder="relationship"
        className="w-32 rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
      />
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            await updateContactRelationship(contactId, value);
            setSaved(true);
          })
        }
        className="rounded-md border border-zinc-300 px-2 py-0.5 text-2xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        {pending ? 'Saving…' : 'Save'}
      </button>
      {saved && !pending ? (
        <span className="text-2xs font-medium text-emerald-600 dark:text-emerald-400">Saved ✓</span>
      ) : null}
    </span>
  );
}
