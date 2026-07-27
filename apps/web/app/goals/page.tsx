import {
  type GoalDashboardItem,
  type GoalSnapshot,
  listGoalsDashboard,
} from '@assistant/application/goals';
import Link from 'next/link';
import { GoalCard, type GoalView } from '@/app/goals/goal-card';
import { GoalCreateForm } from '@/app/goals/goal-create-form';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import { btn, EmptyState, PageHeader, PageShell, SectionHeading } from '@/lib/ui';
import { ActionMenu, SubmitButton } from '@/lib/ui-client';
import { statusLabel } from '@/lib/views';
import { archiveInactiveGoals } from './actions';

export const metadata = { title: 'Goals' };

export const dynamic = 'force-dynamic';

const STATUS_ORDER = ['active', 'paused', 'done', 'abandoned'] as const;
// Headings match the status chip vocabulary (statusLabel), so a goal is never
// filed under one word and labelled with another.
const statusHeadings: Record<(typeof STATUS_ORDER)[number], string> = {
  active: 'Active',
  paused: 'Paused',
  done: 'Completed',
  abandoned: 'Stopped',
};

/** "Due Oct 9 — 11w left" / "Due tomorrow" / "Due Oct 9 — 5d overdue". */
function targetMeta(target: Date | null, now: Date): GoalView['targetMeta'] {
  if (!target) return null;
  const days = Math.round((target.getTime() - now.getTime()) / 86_400_000);
  // Targets are stored as UTC dates; format in UTC so "Sep 1" never renders
  // as "Aug 31" in a western timezone.
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    ...(target.getUTCFullYear() === now.getUTCFullYear() ? {} : { year: 'numeric' }),
  }).format(target);
  if (days < 0) return { label: `Due ${date} — ${-days}d overdue`, overdue: true };
  if (days === 0) return { label: 'Due today', overdue: false };
  if (days === 1) return { label: 'Due tomorrow', overdue: false };
  if (days < 15) return { label: `Due ${date} — ${days}d left`, overdue: false };
  return { label: `Due ${date} — ${Math.round(days / 7)}w left`, overdue: false };
}

/** Where "now" sits between the goal's start and its target, 0–100. */
function timelinePct(goal: GoalSnapshot, now: Date): number | null {
  if (!goal.targetDate) return null;
  const start = goal.createdAt.getTime();
  const span = goal.targetDate.getTime() - start;
  if (span <= 0) return null;
  return Math.min(100, Math.max(0, Math.round(((now.getTime() - start) / span) * 100)));
}

function toGoalView(
  goal: GoalSnapshot,
  now: Date,
  conversationId: string | undefined,
  workActive: boolean,
  automation: { enabled: boolean; nextRunAt: Date | null } | undefined,
  cadenceLabel: string,
  blockedQuestion: string,
  stalled: boolean,
  lastSession: { id: string; status: string; updatedAt: Date } | undefined,
): GoalView {
  const targetDateInput = goal.targetDate ? goal.targetDate.toISOString().slice(0, 10) : '';
  const blocked =
    goal.status === 'active' && !goal.archivedAt && (blockedQuestion !== '' || stalled);
  const isAutomating = goal.status === 'active' && !goal.archivedAt;
  const open = goal.status === 'active' || goal.status === 'paused';
  return {
    id: goal.id,
    title: goal.title,
    description: goal.description,
    status: goal.status,
    priority: goal.priority,
    progress: goal.progress,
    nextAction: goal.nextAction,
    targetDateInput,
    updatedLabel: relativeTime(goal.updatedAt, now),
    conversationId,
    archived: goal.archivedAt !== null,
    workActive,
    paceMeta: isAutomating
      ? `Checks in ${cadenceLabel}`
      : goal.status === 'paused' && !goal.archivedAt
        ? 'Automation paused'
        : '',
    // A healthy-looking countdown under a blocked goal reads as "all fine", so
    // the next-run label stays off while the goal is waiting on the owner.
    automationNextLabel:
      isAutomating && !blocked && automation?.enabled && automation.nextRunAt
        ? `next ${relativeTime(automation.nextRunAt, now)}`
        : '',
    targetMeta: open && !goal.archivedAt ? targetMeta(goal.targetDate, now) : null,
    timelinePct: open && !goal.archivedAt ? timelinePct(goal, now) : null,
    lastSessionLabel: lastSession
      ? `${relativeTime(lastSession.updatedAt, now)} — ${statusLabel(lastSession.status)}`
      : '',
    lastSessionHref: lastSession ? `/tasks/${lastSession.id}` : undefined,
    blockedLabel: blocked
      ? blockedQuestion
        ? `Waiting on you: ${blockedQuestion}`
        : 'Waiting on you — the last session stopped and needs review.'
      : '',
    mirrorToPrimary: goal.mirrorToPrimary,
    autonomy: goal.autonomy,
    taintedOrigin: goal.taintedOrigin,
  };
}

export default async function GoalsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  await requireOwner();
  const { view } = await searchParams;
  const archived = view === 'archived';
  const db = getDb();
  const now = new Date();

  const { items, archivedCount } = await listGoalsDashboard(db, archived, now);
  const rows = items.map((item) => item.goal);
  const automationByGoalId = new Map<string, { enabled: boolean; nextRunAt: Date | null }>();
  for (const item of items) {
    if (item.automation) automationByGoalId.set(item.goal.id, item.automation);
  }
  const cards = items.map((item: GoalDashboardItem) => ({
    key: `${item.goal.id}:${item.goal.updatedAt.getTime()}`,
    status: item.goal.status,
    view: toGoalView(
      item.goal,
      now,
      item.conversationId,
      item.workActive,
      item.automation,
      item.cadenceLabel,
      item.blockedQuestion,
      item.stalled,
      item.lastSession,
    ),
  }));
  const groups = STATUS_ORDER.map((status) => ({
    status,
    items: cards.filter((card) => card.status === status),
  })).filter((group) => group.items.length > 0);
  // Goals waiting on the owner lead the Active section — they are the ones a
  // visit to this page can actually unblock.
  for (const group of groups) {
    if (group.status === 'active') {
      group.items.sort(
        (a, b) => Number(b.view.blockedLabel !== '') - Number(a.view.blockedLabel !== ''),
      );
    }
  }

  // One-line digest: what needs the owner, what runs on its own, when the
  // assistant looks at any of it next.
  const activeCards = archived ? [] : cards.filter((card) => card.status === 'active');
  const blockedCount = activeCards.filter((card) => card.view.blockedLabel !== '').length;
  const selfRunningCount = activeCards.length - blockedCount;
  const nextCheckIns = activeCards
    .filter((card) => card.view.blockedLabel === '')
    .map((card) => automationByGoalId.get(card.view.id))
    .filter(
      (automation): automation is { enabled: boolean; nextRunAt: Date } =>
        automation?.enabled === true && automation.nextRunAt !== null && automation.nextRunAt > now,
    )
    .map((automation) => automation.nextRunAt.getTime());
  const nextCheckInLabel =
    nextCheckIns.length > 0 ? relativeTime(new Date(Math.min(...nextCheckIns)), now) : '';

  return (
    <PageShell size="reading">
      <PageHeader
        title={archived ? 'Archived goals' : 'Goals'}
        intro={
          archived
            ? 'Archived goals keep their work chats, tasks, and evidence. Restore one whenever you want to continue.'
            : 'Give the assistant an outcome to keep moving forward. Each goal has its own chat for updates and direction.'
        }
        actions={
          archived ? (
            <Link href="/goals" className={btn.outline}>
              Current goals
            </Link>
          ) : (
            <>
              {archivedCount > 0 ? (
                <Link href="/goals?view=archived" className={btn.outline}>
                  Archived ({archivedCount})
                </Link>
              ) : null}
              <ActionMenu label="More" panelClassName="w-64">
                <form action={archiveInactiveGoals}>
                  <SubmitButton pendingLabel="Archiving…" className="w-full">
                    Archive old finished goals
                  </SubmitButton>
                </form>
                <p className="px-1 text-xs text-zinc-500">
                  Hides goals finished more than 30 days ago. Their history is kept.
                </p>
              </ActionMenu>
            </>
          )
        }
      />

      {activeCards.length > 0 ? (
        <p className="mt-3 text-[13px] leading-5 text-muted">
          {blockedCount > 0 ? (
            <>
              <span className="font-medium text-amber-700 dark:text-amber-400">
                {blockedCount} waiting on you
              </span>
              {' · '}
            </>
          ) : null}
          {selfRunningCount > 0
            ? `${selfRunningCount} moving on ${selfRunningCount === 1 ? 'its' : 'their'} own`
            : null}
          {selfRunningCount > 0 && nextCheckInLabel ? ' · ' : null}
          {nextCheckInLabel ? `next check-in ${nextCheckInLabel}` : null}
        </p>
      ) : null}

      {!archived ? <GoalCreateForm startOpen={rows.length === 0} /> : null}

      {rows.length === 0 ? (
        <EmptyState>
          {archived
            ? 'No archived goals.'
            : 'No goals yet. Give me an outcome to keep moving — a trip to plan, a search to run — and I check in on it on a schedule.'}
        </EmptyState>
      ) : (
        <div className="mt-8 flex flex-col gap-6">
          {groups.map((group) => (
            <section key={group.status}>
              <SectionHeading title={statusHeadings[group.status]} count={group.items.length} />
              <div className="mt-3 flex flex-col gap-4">
                {group.items.map((card) => (
                  <GoalCard key={card.key} goal={card.view} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </PageShell>
  );
}
