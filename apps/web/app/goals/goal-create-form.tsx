'use client';

import { useActionState } from 'react';
import { createGoal } from '@/app/goals/actions';
import { btn, cardShellClass, inputClass, labelClass, textareaClass } from '@/lib/ui';
import { PACE_OPTIONS } from './pace';

export function GoalCreateForm() {
  const [state, formAction, pending] = useActionState(createGoal, { error: null });

  return (
    <form action={formAction} className={`${cardShellClass} mt-6 p-5`}>
      <h2 className="text-sm font-medium">Create a goal</h2>
      <p className="mt-1 text-xs leading-5 text-zinc-600 dark:text-zinc-400">
        Tell the assistant what outcome you want. It will start now and keep the work moving.
      </p>
      <div className="mt-3 flex flex-col gap-3">
        <label className={labelClass}>
          Title
          <input
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
          <summary className="cursor-pointer text-xs font-medium text-zinc-600 dark:text-zinc-400">
            Pace, target date, and updates
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            <div className="flex flex-wrap gap-3">
              <label className={labelClass}>
                Pace
                <select
                  name="priority"
                  defaultValue={state.values?.priority || '3'}
                  className={`${inputClass} w-full`}
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
            <label className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-400">
              <input type="checkbox" name="mirrorToPrimary" className="mt-0.5" />
              <span>Also show background updates in my main chat.</span>
            </label>
          </div>
        </details>
      </div>
      {state.error ? (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{state.error}</p>
      ) : null}
      <button type="submit" disabled={pending} className={`${btn.primary} mt-3`}>
        {pending ? 'Starting…' : 'Start this goal'}
      </button>
    </form>
  );
}
