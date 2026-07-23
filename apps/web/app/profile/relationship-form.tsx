'use client';

import { useState, useTransition } from 'react';
import { updateContactRelationship } from '@/app/profile/actions';
import { btnSm, inputClass } from '@/lib/ui';

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
        className={`${inputClass} w-36`}
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
        className={btnSm.outline}
      >
        {pending ? 'Saving…' : 'Save'}
      </button>
      {saved && !pending ? (
        <span className="text-2xs font-medium text-emerald-600 dark:text-emerald-400">Saved ✓</span>
      ) : null}
    </span>
  );
}
