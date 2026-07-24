'use client';

import { UserPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { createPersonAction } from '@/app/profile/actions';
import { btn, btnSm, inputClass, labelClass } from '@/lib/ui';

/** Owner-driven "add a person" — creates a known contact and opens their page. */
export function AddPerson() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={btnSm.outline}>
        <UserPlus className="size-3.5" aria-hidden="true" />
        Add person
      </button>
    );
  }

  return (
    <form
      className="mt-3 flex flex-col gap-3 rounded-2xl border border-edge bg-raised p-4"
      action={(formData) =>
        startTransition(async () => {
          setError(null);
          const result = await createPersonAction({
            name: String(formData.get('name') ?? ''),
            relationship: String(formData.get('relationship') ?? ''),
            aliases: String(formData.get('aliases') ?? ''),
          });
          if (result.error) setError(result.error);
          else if (result.contactId) router.push(`/profile/people/${result.contactId}`);
          else {
            setOpen(false);
            router.refresh();
          }
        })
      }
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className={`flex flex-col gap-1 ${labelClass}`}>
          Name
          <input name="name" type="text" required className={`${inputClass} w-56`} />
        </label>
        <label className={`flex flex-col gap-1 ${labelClass}`}>
          Relationship
          <input
            name="relationship"
            type="text"
            placeholder="e.g. sister, colleague"
            className={`${inputClass} w-44`}
          />
        </label>
        <label className={`flex flex-col gap-1 ${labelClass}`}>
          Also known as (optional)
          <input
            name="aliases"
            type="text"
            placeholder="nicknames, comma separated"
            className={`${inputClass} w-56`}
          />
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button type="submit" disabled={pending} className={btn.primary}>
          {pending ? 'Adding…' : 'Add person'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={btn.outline}>
          Cancel
        </button>
        {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
      </div>
    </form>
  );
}
