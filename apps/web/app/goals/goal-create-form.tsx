'use client';

import { useActionState } from 'react';
import { createGoal } from '@/app/goals/actions';

const inputClass =
  'w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900';
const labelClass = 'flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400';

export function GoalCreateForm() {
  const [state, formAction, pending] = useActionState(createGoal, { error: null });

  return (
    <form
      action={formAction}
      className="mt-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
    >
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
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          Description (optional)
          <textarea
            name="description"
            rows={2}
            placeholder="Context, constraints, definition of done…"
            defaultValue={state.values?.description ?? ''}
            className={inputClass}
          />
        </label>
        <details className="rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <summary className="cursor-pointer text-xs font-medium text-zinc-600 dark:text-zinc-400">
            Schedule and notification options
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            <div className="flex flex-wrap gap-3">
              <label className={labelClass}>
                How often should it work?
                <select
                  name="priority"
                  defaultValue={state.values?.priority || '3'}
                  className={inputClass}
                >
                  <option value="1">Every 6 hours</option>
                  <option value="2">Daily</option>
                  <option value="3">Twice a week</option>
                  <option value="4">Weekly</option>
                  <option value="5">Monthly</option>
                </select>
              </label>
              <label className={labelClass}>
                Target date (optional)
                <input
                  type="date"
                  name="targetDate"
                  defaultValue={state.values?.targetDate ?? ''}
                  className={inputClass}
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
      <button
        type="submit"
        disabled={pending}
        className="mt-3 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? 'Starting…' : 'Create goal and start work'}
      </button>
    </form>
  );
}
