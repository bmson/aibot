'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { deleteContactAction, updateContactIdentityAction } from '@/app/profile/actions';
import { btn } from '@/lib/ui';

export function PersonControls({
  contactId,
  initialName,
  initialAliases,
}: {
  contactId: string;
  initialName: string;
  initialAliases: string[];
}) {
  const [name, setName] = useState(initialName);
  const [aliases, setAliases] = useState(initialAliases.join(', '));
  const [saved, setSaved] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const displayName = name.trim() || initialName;

  const save = () => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateContactIdentityAction(contactId, name, aliases);
      if (result.error) setError(result.error);
      else setSaved(true);
    });
  };

  const remove = () => {
    setError(null);
    startTransition(async () => {
      const result = await deleteContactAction(contactId);
      if (result.error) {
        setError(result.error);
        setConfirmingDelete(false);
      } else {
        router.push('/profile');
        router.refresh();
      }
    });
  };

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
      <input
        type="text"
        value={name}
        maxLength={120}
        disabled={pending}
        aria-label={`Name for ${initialName}`}
        onChange={(event) => {
          setName(event.target.value);
          setSaved(false);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save();
        }}
        className="w-48 rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
      />
      <input
        type="text"
        value={aliases}
        maxLength={4_000}
        disabled={pending}
        aria-label={`Aliases for ${initialName}`}
        placeholder="aliases, comma separated"
        onChange={(event) => {
          setAliases(event.target.value);
          setSaved(false);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save();
        }}
        className="w-56 rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
      />
      <button type="button" disabled={pending} onClick={save} className={btn.outline}>
        {pending && !confirmingDelete ? 'Saving…' : 'Save identity'}
      </button>
      {saved && !pending ? (
        <span className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
          Saved ✓
        </span>
      ) : null}

      {confirmingDelete ? (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-red-700 dark:text-red-400">
            Delete {displayName} and all associated facts permanently?
          </span>
          <button type="button" disabled={pending} onClick={remove} className={btn.danger}>
            {pending ? 'Deleting…' : 'Confirm delete'}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirmingDelete(false)}
            className={btn.outline}
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setConfirmingDelete(true);
            setSaved(false);
            setError(null);
          }}
          className={btn.dangerOutline}
        >
          Delete person
        </button>
      )}

      {error ? (
        <span role="alert" className="w-full text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : null}
    </div>
  );
}
