'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import {
  archiveGoal,
  restoreGoal,
  setGoalAutonomy,
  setGoalStatus,
  startGoalWork,
  updateGoal,
} from '@/app/goals/actions';
import {
  btn,
  cardBodyClass,
  cardFooterClass,
  cardHeaderClass,
  cardShellClass,
  InfoGrid,
  InfoItem,
  inputClass as sharedInputClass,
  labelClass as sharedLabelClass,
  textareaClass,
} from '@/lib/ui';
import { SubmitButton } from '@/lib/ui-client';
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
  /** The chat created when this goal was started, if it has one. */
  conversationId?: string;
  /** Archived goals are hidden from the current list but not deleted. */
  archived: boolean;
  /** Archive is unavailable while the linked goal still has unfinished work. */
  workActive: boolean;
  /** A human-readable recurrence; cron expressions stay out of the Goals UI. */
  automationLabel: string;
  /** e.g. 'next in 4h', empty if automation is not running. */
  automationNextLabel: string;
  /**
   * 'Blocked — needs you: …' when automatic work is stalled on the owner
   * (unanswered question or a needs_attention session); '' when healthy.
   * Without this the card shows only the next-run countdown, which looks
   * healthy while the automation is actually suspended.
   */
  blockedLabel: string;
  /** Mirror this goal's autonomous updates into the primary chat thread. */
  mirrorToPrimary: boolean;
  /** Free-range: each automatic session acts without per-step approval (floor still applies). */
  autonomy: boolean;
  /** A goal from external content — can never be armed free-range. */
  taintedOrigin: boolean;
}

const outlineButton = btn.outline;
const dangerOutlineButton = btn.dangerOutline;
const inputClass = `${sharedInputClass} w-full`;
const labelClass = `flex flex-col gap-1 ${sharedLabelClass}`;

const priorityChipClasses: Record<number, string> = {
  1: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  2: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  3: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  4: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  5: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500',
};

const priorityLabels: Record<number, string> = {
  1: 'Urgent',
  2: 'High',
  3: 'Normal',
  4: 'Low',
  5: 'Later',
};

function PriorityBadge({ priority }: { priority: number }) {
  const classes = priorityChipClasses[priority] ?? priorityChipClasses[3];
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${classes}`}
      title={`Priority: ${priorityLabels[priority] ?? 'Normal'}`}
    >
      {priorityLabels[priority] ?? 'Normal'}
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
    <div id={`goal-${goal.id}`} className={`${cardShellClass} scroll-mt-20`}>
      <div className={cardBodyClass}>
        <div className={cardHeaderClass}>
          <div className="min-w-0">
            <h3 className="text-[16px] leading-6 font-semibold tracking-[-0.015em]">
              {goal.title}
            </h3>
            {goal.description ? (
              <p className="mt-1 text-[13px] leading-5 text-muted">{goal.description}</p>
            ) : null}
          </div>
          <span className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <PriorityBadge priority={goal.priority} />
            <StatusChip status={goal.status} />
          </span>
        </div>

        <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(15rem,0.72fr)]">
          <section className="min-w-0">
            <h4 className="text-2xs font-semibold tracking-[0.08em] text-muted uppercase">
              Current progress
            </h4>
            <p className="mt-1 text-[14px] leading-6 text-strong">
              {goal.progress || 'No progress update yet.'}
            </p>
            {goal.blockedLabel ? (
              <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2.5 text-xs leading-5 font-medium text-amber-800 dark:bg-amber-950/35 dark:text-amber-300">
                {goal.blockedLabel}
              </p>
            ) : goal.nextAction ? (
              <div className="mt-3 border-l-2 border-accent/50 pl-3">
                <p className="text-2xs font-semibold tracking-[0.08em] text-muted uppercase">
                  Next action
                </p>
                <p className="mt-0.5 text-[13px] leading-5 text-strong">{goal.nextAction}</p>
              </div>
            ) : null}
          </section>
          <InfoGrid>
            <InfoItem label="Target">{goal.targetLabel || 'No target date'}</InfoItem>
            <InfoItem label="Updated">{goal.updatedLabel}</InfoItem>
            <InfoItem label="Automation" className="col-span-2">
              {goal.automationLabel}
              {goal.automationNextLabel ? ` · ${goal.automationNextLabel}` : ''}
            </InfoItem>
          </InfoGrid>
        </div>

        {goal.mirrorToPrimary || goal.autonomy ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {goal.mirrorToPrimary ? (
              <p className="rounded-xl bg-indigo-50 px-3 py-2.5 text-xs leading-5 text-indigo-800 dark:bg-indigo-950/30 dark:text-indigo-300">
                ↩ Updates also appear in your main chat.
              </p>
            ) : null}
            {goal.autonomy ? (
              <p className="rounded-xl bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                ⚡ Free-range sessions handle routine approvals; sensitive actions still ask.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className={cardFooterClass}>
        {goal.conversationId ? (
          <Link href={`/chat/${goal.conversationId}`} className={outlineButton}>
            Open work chat
          </Link>
        ) : null}
        {goal.archived ? (
          <form action={restoreGoal.bind(null, goal.id)}>
            <SubmitButton variant="outline" pendingLabel="Restoring…">
              Restore goal
            </SubmitButton>
          </form>
        ) : (
          <>
            {!goal.conversationId ? (
              <form action={startGoalWork.bind(null, goal.id)}>
                <SubmitButton variant="outline" pendingLabel="Starting…">
                  Start work now
                </SubmitButton>
              </form>
            ) : null}
            {goal.status === 'active' ? (
              <form action={setGoalStatus.bind(null, goal.id, 'paused')}>
                <SubmitButton variant="outline" pendingLabel="Pausing…">
                  Pause automation
                </SubmitButton>
              </form>
            ) : null}
            {goal.status === 'paused' ? (
              <form action={setGoalStatus.bind(null, goal.id, 'active')}>
                <SubmitButton variant="outline" pendingLabel="Resuming…">
                  Resume automation
                </SubmitButton>
              </form>
            ) : null}
            {!goal.taintedOrigin ? (
              <form action={setGoalAutonomy.bind(null, goal.id, !goal.autonomy)}>
                <SubmitButton variant="outline" pendingLabel="Updating…">
                  {goal.autonomy ? 'Turn off free-range' : 'Make free-range'}
                </SubmitButton>
              </form>
            ) : null}
            {goal.workActive ? (
              <span className="self-center text-xs text-zinc-500 dark:text-zinc-500">
                Work active
              </span>
            ) : null}
            <details className="relative">
              <summary className={`${outlineButton} cursor-pointer list-none`}>More</summary>
              <div className="absolute top-full right-0 z-10 mt-2 flex w-52 flex-col gap-2 rounded-xl border border-edge bg-raised p-3 shadow-lg">
                <button
                  type="button"
                  onClick={(event) => {
                    setEditing((value) => !value);
                    event.currentTarget.closest('details')?.removeAttribute('open');
                  }}
                  className={outlineButton}
                >
                  {editing ? 'Close editor' : 'Edit goal'}
                </button>
                {open ? (
                  <form action={setGoalStatus.bind(null, goal.id, 'done')}>
                    <SubmitButton variant="outline" pendingLabel="Finishing…" className="w-full">
                      Mark done
                    </SubmitButton>
                  </form>
                ) : (
                  <form action={setGoalStatus.bind(null, goal.id, 'active')}>
                    <SubmitButton variant="outline" pendingLabel="Reactivating…" className="w-full">
                      Reactivate
                    </SubmitButton>
                  </form>
                )}
                {!goal.workActive ? (
                  <form action={archiveGoal.bind(null, goal.id)}>
                    <SubmitButton variant="outline" pendingLabel="Archiving…" className="w-full">
                      Archive
                    </SubmitButton>
                  </form>
                ) : null}
                {goal.status !== 'abandoned' ? (
                  confirmingAbandon ? (
                    <div className="flex flex-col gap-2">
                      <form action={setGoalStatus.bind(null, goal.id, 'abandoned')}>
                        <SubmitButton variant="danger" pendingLabel="Stopping…" className="w-full">
                          Confirm stop
                        </SubmitButton>
                      </form>
                      <button
                        type="button"
                        onClick={() => setConfirmingAbandon(false)}
                        className={outlineButton}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmingAbandon(true)}
                      className={dangerOutlineButton}
                    >
                      Stop goal
                    </button>
                  )
                ) : null}
              </div>
            </details>
          </>
        )}
      </div>

      {editing && !goal.archived ? (
        <form action={editAction} className="flex flex-col gap-3 border-t border-edge p-4 sm:p-5">
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
              className={`${textareaClass} w-full`}
            />
          </label>
          <div className="flex flex-wrap gap-3">
            <label className={labelClass}>
              Automation pace
              <select
                name="priority"
                defaultValue={value('priority', String(goal.priority))}
                className={inputClass}
              >
                <option value="1">Urgent — every 6 hours</option>
                <option value="2">High — daily</option>
                <option value="3">Normal — twice a week</option>
                <option value="4">Low — weekly</option>
                <option value="5">Later — monthly</option>
              </select>
            </label>
            <label className={labelClass}>
              Target date (speeds up as it gets close)
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
          <label className="flex items-start gap-2 text-xs font-normal text-zinc-600 dark:text-zinc-400">
            <input
              type="checkbox"
              name="mirrorToPrimary"
              defaultChecked={goal.mirrorToPrimary}
              className="mt-0.5"
            />
            <span>Show this goal’s background updates in my main chat thread</span>
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
