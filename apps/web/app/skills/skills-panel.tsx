'use client';

import { useState, useTransition } from 'react';
import {
  addSkillAction,
  deleteSkillAction,
  editSkillAction,
  toggleSkillDeprecatedAction,
} from '@/app/skills/actions';
import {
  btn,
  inputClass as sharedInputClass,
  textareaClass as sharedTextareaClass,
} from '@/lib/ui';

export interface SkillView {
  id: string;
  name: string;
  preconditions: string;
  steps: string;
  gotchas: string;
  ownerAuthored: boolean;
  deprecated: boolean;
  useCount: number;
  successCount: number;
  failureCount: number;
  createdLabel: string;
}

const inputClass = `${sharedInputClass} w-full`;

function SkillForm({
  initial,
  submitting,
  onSubmit,
  onCancel,
  error,
}: {
  initial?: Partial<SkillView>;
  submitting: boolean;
  onSubmit: (fd: FormData) => void;
  onCancel?: () => void;
  error?: string | null;
}) {
  return (
    <form action={onSubmit} className="flex flex-col gap-2">
      <input
        name="name"
        defaultValue={initial?.name ?? ''}
        placeholder="Name (e.g. Booking flights)"
        required
        className={`${sharedTextareaClass} w-full`}
      />
      <input
        name="preconditions"
        defaultValue={initial?.preconditions ?? ''}
        placeholder="When it applies (optional)"
        className={inputClass}
      />
      <textarea
        name="steps"
        defaultValue={initial?.steps ?? ''}
        placeholder="Steps — the procedure, in plain language"
        required
        rows={3}
        className={inputClass}
      />
      <input
        name="gotchas"
        defaultValue={initial?.gotchas ?? ''}
        placeholder="Gotchas (optional)"
        className={inputClass}
      />
      <div className="flex items-center gap-2">
        <button type="submit" disabled={submitting} className={btn.primary}>
          Save skill
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel} className={btn.outline}>
            Cancel
          </button>
        ) : null}
        {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
      </div>
    </form>
  );
}

export function SkillsPanel({ skills }: { skills: SkillView[] }) {
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fields = (fd: FormData) => ({
    name: String(fd.get('name') ?? ''),
    preconditions: String(fd.get('preconditions') ?? ''),
    steps: String(fd.get('steps') ?? ''),
    gotchas: String(fd.get('gotchas') ?? ''),
  });

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-baseline gap-2 text-sm font-medium">
          Skills
          <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-2xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            {skills.length}
          </span>
        </h2>
        {!adding ? (
          <button type="button" onClick={() => setAdding(true)} className={btn.outline}>
            Add skill
          </button>
        ) : null}
      </div>

      {adding ? (
        <div className="mt-3 rounded-2xl bg-raised p-4 shadow-[0_1px_2px_rgb(23_25_35/0.06)]">
          <SkillForm
            submitting={pending}
            error={error}
            onCancel={() => {
              setAdding(false);
              setError(null);
            }}
            onSubmit={(fd) =>
              startTransition(async () => {
                setError(null);
                const result = await addSkillAction(fields(fd));
                if (result.error) setError(result.error);
                else setAdding(false);
              })
            }
          />
        </div>
      ) : null}

      {skills.length === 0 && !adding ? (
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
          No skills yet — the assistant drafts these from tasks it solves a non-obvious way, and you
          can add your own.
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {skills.map((s) => (
            <div
              key={s.id}
              className={`rounded-2xl bg-raised p-4 shadow-[0_1px_2px_rgb(23_25_35/0.06)] ${
                s.deprecated ? 'opacity-60' : ''
              }`}
            >
              {editingId === s.id ? (
                <SkillForm
                  initial={s}
                  submitting={pending}
                  error={error}
                  onCancel={() => {
                    setEditingId(null);
                    setError(null);
                  }}
                  onSubmit={(fd) =>
                    startTransition(async () => {
                      setError(null);
                      const result = await editSkillAction(s.id, fields(fd));
                      if (result.error) setError(result.error);
                      else setEditingId(null);
                    })
                  }
                />
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{s.name}</span>
                    {s.ownerAuthored ? (
                      <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-2xs font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-300">
                        yours
                      </span>
                    ) : (
                      <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-2xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                        learned
                      </span>
                    )}
                    {s.deprecated ? (
                      <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-2xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                        retired
                      </span>
                    ) : null}
                    <span className="ml-auto text-2xs text-zinc-500 dark:text-zinc-500">
                      used {s.useCount}× · {s.successCount}✓ / {s.failureCount}✗
                    </span>
                  </div>
                  {s.preconditions ? (
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      When: {s.preconditions}
                    </p>
                  ) : null}
                  <p className="mt-1 text-sm whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">
                    {s.steps}
                  </p>
                  {s.gotchas ? (
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      Gotchas: {s.gotchas}
                    </p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(s.id);
                        setError(null);
                      }}
                      className={btn.outline}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        startTransition(() => toggleSkillDeprecatedAction(s.id, !s.deprecated))
                      }
                      className={btn.outline}
                    >
                      {s.deprecated ? 'Restore' : 'Retire'}
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => startTransition(() => deleteSkillAction(s.id))}
                      className={btn.dangerOutline}
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
