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
        This opens a work chat and starts one task now. It will not set up recurring work unless you
        ask for it.
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
        <div className="flex flex-wrap gap-3">
          <label className={labelClass}>
            Priority
            <select
              name="priority"
              defaultValue={state.values?.priority || '3'}
              className={inputClass}
            >
              <option value="1">Urgent</option>
              <option value="2">High</option>
              <option value="3">Normal</option>
              <option value="4">Low</option>
              <option value="5">Later</option>
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
