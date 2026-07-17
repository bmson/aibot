'use client';

import { useActionState, useState } from 'react';
import { setGoalStatus, updateGoal } from '@/app/goals/actions';
import { btn } from '@/lib/ui';
import { StatusChip } from '@/lib/views';

/** Plain-serializable props built server-side in page.tsx (labels precomputed there). */
export interface GoalView {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  progress: string;
  nextAction: string;
  /** 'YYYY-MM-DD' for the edit form's date input, '' when unset. */
  targetDateInput: string;
  /** e.g. 'target in 30d (2026-08-14)', '' when unset. */
  targetLabel: string;
  /** e.g. 'updated 3m ago'. */
  updatedLabel: string;
}

const outlineButton = btn.outline;
const dangerOutlineButton = btn.dangerOutline;
const dangerButton = btn.danger;
const inputClass =
  'w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900';
const labelClass = 'flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400';

const priorityChipClasses: Record<number, string> = {
  1: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  2: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  3: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  4: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  5: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500',
};

function PriorityBadge({ priority }: { priority: number }) {
  const classes = priorityChipClasses[priority] ?? priorityChipClasses[3];
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${classes}`}
      title={`Priority ${priority} (1 = highest)`}
    >
      P{priority}
    </span>
  );
}

export function GoalCard({ goal }: { goal: GoalView }) {
  // The parent keys this card by goal.updatedAt, so a successful save/status change
  // remounts it with editing/confirming reset — no effects needed.
  const [editing, setEditing] = useState(false);
  const [confirmingAbandon, setConfirmingAbandon] = useState(false);
  const [editState, editAction, editPending] = useActionState(updateGoal, { error: null });

  const open = goal.status === 'active' || goal.status === 'paused';
  const value = (name: string, fallback: string) => editState.values?.[name] ?? fallback;

  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-sm font-medium">{goal.title}</p>
        <span className="flex shrink-0 items-center gap-2">
          <PriorityBadge priority={goal.priority} />
          <StatusChip status={goal.status} />
        </span>
      </div>
      {goal.description ? (
        <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{goal.description}</p>
      ) : null}
      {goal.progress ? (
        <p className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-500">
          progress: {goal.progress}
        </p>
      ) : null}
      {goal.nextAction ? (
        <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-500">
          next: {goal.nextAction}
        </p>
      ) : null}
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
        {goal.targetLabel ? `${goal.targetLabel} · ` : ''}
        {goal.updatedLabel}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => setEditing((v) => !v)} className={outlineButton}>
          {editing ? 'Close' : 'Edit'}
        </button>
        {goal.status === 'active' ? (
          <form action={setGoalStatus.bind(null, goal.id, 'paused')}>
            <button type="submit" className={outlineButton}>
              Pause
            </button>
          </form>
        ) : null}
        {goal.status === 'paused' ? (
          <form action={setGoalStatus.bind(null, goal.id, 'active')}>
            <button type="submit" className={outlineButton}>
              Resume
            </button>
          </form>
        ) : null}
        {open ? (
          <form action={setGoalStatus.bind(null, goal.id, 'done')}>
            <button type="submit" className={outlineButton}>
              Mark done
            </button>
          </form>
        ) : (
          <form action={setGoalStatus.bind(null, goal.id, 'active')}>
            <button type="submit" className={outlineButton}>
              Reactivate
            </button>
          </form>
        )}
        {goal.status !== 'abandoned' ? (
          confirmingAbandon ? (
            <>
              <form action={setGoalStatus.bind(null, goal.id, 'abandoned')}>
                <button type="submit" className={dangerButton}>
                  Confirm abandon
                </button>
              </form>
              <button
                type="button"
                onClick={() => setConfirmingAbandon(false)}
                className={outlineButton}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingAbandon(true)}
              className={dangerOutlineButton}
            >
              Abandon
            </button>
          )
        ) : null}
      </div>

      {editing ? (
        <form
          action={editAction}
          className="mt-3 flex flex-col gap-3 border-t border-zinc-200 pt-3 dark:border-zinc-800"
        >
          <input type="hidden" name="goalId" value={goal.id} />
          <label className={labelClass}>
            Title
            <input
              type="text"
              name="title"
              required
              defaultValue={value('title', goal.title)}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Description
            <textarea
              name="description"
              rows={2}
              defaultValue={value('description', goal.description)}
              className={inputClass}
            />
          </label>
          <div className="flex flex-wrap gap-3">
            <label className={labelClass}>
              Priority
              <select
                name="priority"
                defaultValue={value('priority', String(goal.priority))}
                className={inputClass}
              >
                <option value="1">P1 — highest</option>
                <option value="2">P2</option>
                <option value="3">P3</option>
                <option value="4">P4</option>
                <option value="5">P5 — lowest</option>
              </select>
            </label>
            <label className={labelClass}>
              Target date
              <input
                type="date"
                name="targetDate"
                defaultValue={value('targetDate', goal.targetDateInput)}
                className={inputClass}
              />
            </label>
          </div>
          <label className={labelClass}>
            Progress
            <input
              type="text"
              name="progress"
              defaultValue={value('progress', goal.progress)}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Next action
            <input
              type="text"
              name="nextAction"
              defaultValue={value('nextAction', goal.nextAction)}
              className={inputClass}
            />
          </label>
          {editState.error ? (
            <p className="text-xs text-red-600 dark:text-red-400">{editState.error}</p>
          ) : null}
          <div className="flex gap-2">
            <button type="submit" disabled={editPending} className={btn.primary}>
              {editPending ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => setEditing(false)} className={outlineButton}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
