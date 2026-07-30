'use client';

import { Plus } from 'lucide-react';
import { useActionState, useRef, useState } from 'react';
import { createGoal } from '@/app/goals/actions';
import {
  btn,
  cardShellClass,
  cardTitleClass,
  focusRing,
  inputClass,
  labelClass,
  selectClass,
  textareaClass,
} from '@/lib/ui';
import { PACE_OPTIONS } from './pace';

/**
 * Collapsed to one inviting line by default so the goals themselves lead the
 * page; opens into the full form on click. `startOpen` keeps it expanded when
 * there is nothing on the page yet.
 */
export function GoalCreateForm({ startOpen = false }: { startOpen?: boolean }) {
  const [state, formAction, pending] = useActionState(createGoal, { error: null });
  const [open, setOpen] = useState(startOpen);
  const titleRef = useRef<HTMLInputElement | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          // Focus after the form mounts, so typing can start immediately.
          requestAnimationFrame(() => titleRef.current?.focus());
        }}
        // Stacks on a phone: side by side, the prompt wrapped onto two lines
        // and squeezed the pill against it. Full width also gives the primary
        // action a proper thumb target.
        className={`${cardShellClass} mt-6 flex w-full flex-col items-stretch gap-3 px-4 py-3 text-left motion-safe:transition-shadow hover:ring-accent/40 sm:flex-row sm:items-center sm:justify-between sm:px-5 ${focusRing}`}
      >
        <span className="text-[14px] text-muted">
          Give the assistant a new outcome to work toward…
        </span>
        <span
          className={`${btn.primary} pointer-events-none w-full justify-center sm:w-auto`}
          // Presentation only — the whole bar is the real button.
          aria-hidden="true"
        >
          <Plus className="size-4" aria-hidden="true" />
          New goal
        </span>
      </button>
    );
  }

  return (
    <form action={formAction} className={`${cardShellClass} mt-6 p-5`}>
      <h2 className={cardTitleClass}>Create a goal</h2>
      <p className="mt-1 text-xs leading-5 text-muted">
        Tell the assistant what outcome you want. It will start now and keep the work moving.
      </p>
      <div className="mt-3 flex flex-col gap-3">
        <label className={labelClass}>
          Title
          <input
            ref={titleRef}
            type="text"
            name="title"
            required
            placeholder="What should the assistant work toward?"
            defaultValue={state.values?.title ?? ''}
            className={`${inputClass} w-full`}
          />
        </label>
        <label className={labelClass}>
          Description (optional)
          <textarea
            name="description"
            rows={2}
            placeholder="Context, constraints, definition of done…"
            defaultValue={state.values?.description ?? ''}
            className={`${textareaClass} w-full`}
          />
        </label>
        <details className="rounded-xl bg-sunken/55 px-3 py-2">
          <summary className="disclosure flex items-center gap-2 cursor-pointer text-xs font-medium text-muted">
            Pace, target date, and updates
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            <div className="flex flex-wrap gap-3">
              <label className={labelClass}>
                Pace
                <select
                  name="priority"
                  defaultValue={state.values?.priority || '3'}
                  className={`${selectClass} w-full`}
                >
                  {PACE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className={labelClass}>
                Target date (optional)
                <input
                  type="date"
                  name="targetDate"
                  defaultValue={state.values?.targetDate ?? ''}
                  className={`${inputClass} w-full`}
                />
              </label>
            </div>
            <label className="flex items-start gap-2 text-xs text-muted">
              <input type="checkbox" name="mirrorToPrimary" className="mt-0.5 size-4" />
              <span>Also show background updates in my main chat.</span>
            </label>
          </div>
        </details>
      </div>
      {state.error ? (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{state.error}</p>
      ) : null}
      <div className="mt-3 flex gap-2">
        <button type="submit" disabled={pending} className={btn.primary}>
          {pending ? 'Starting…' : 'Start this goal'}
        </button>
        {!startOpen ? (
          <button type="button" onClick={() => setOpen(false)} className={btn.outline}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
