import { getAgent } from '@assistant/core';
import { approvalPolicies, schedules } from '@assistant/db';
import { asc } from 'drizzle-orm';
import Link from 'next/link';
import { deletePolicy, setPolicyEnabled, setScheduleEnabled } from '@/app/settings/actions';
import { AgentForm } from '@/app/settings/agent-form';
import { requireOwner } from '@/auth';
import { formatDateTime, relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import { btn, Card, CountBadge, EmptyState, PageHeader, SectionHeading } from '@/lib/ui';

export const dynamic = 'force-dynamic';

const scheduleLabels: Record<string, string> = {
  'morning-brief': 'Morning brief',
  'memory-extraction': 'Remember useful details from today',
  'memory-consolidation': 'Organize saved memory',
  'chat-segmentation': 'Organize conversation history',
};

const policyLabels: Record<string, string> = {
  'calendar.owner_attendee_only': 'Create calendar invitations for you',
  'calendar.self_only_events': 'Create private events on the assistant calendar',
  'gmail.send.to_recipient': 'Send email to an approved recipient',
  'sms.reply_to_owner': 'Reply to your text messages',
};

export default async function SettingsPage() {
  await requireOwner();
  const db = getDb();
  const now = new Date();

  const [agent, scheduleRows, policyRows] = await Promise.all([
    getAgent(db),
    db.select().from(schedules).orderBy(asc(schedules.name)),
    db.select().from(approvalPolicies).orderBy(asc(approvalPolicies.toolName)),
  ]);
  // Goal-owned schedules are explained and controlled on Goals, where their
  // title, urgency, deadline, and work chat are visible together.
  const directScheduleRows = scheduleRows.filter((schedule) => !schedule.name.startsWith('goal:'));
  const goalAutomationCount = scheduleRows.length - directScheduleRows.length;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8">
      <PageHeader
        title="Settings"
        intro="Configure the assistant — identity, proactive schedules, spend caps, and standing approval rules."
      />

      {/* Identity */}
      <section>
        <SectionHeading title="Assistant" hint={`${agent.name} <${agent.email}>`} />
        <Card className="mt-3">
          <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-500">
            {agent.phoneE164 ? `Phone ${agent.phoneE164} · ` : ''}
            Name, email, and phone are provisioned at deploy time.
          </p>
          <AgentForm
            initial={{ timezone: agent.timezone, locale: agent.locale, signature: agent.signature }}
          />
        </Card>
      </section>

      {/* Schedules */}
      <section>
        <SectionHeading
          title="Other schedules"
          count={directScheduleRows.length}
          hint={
            goalAutomationCount
              ? `${goalAutomationCount} goal automations are managed from Goals.`
              : 'proactive jobs the assistant runs on its own'
          }
        />
        {directScheduleRows.length === 0 ? (
          <EmptyState>
            {goalAutomationCount
              ? 'No other schedules. Manage your automatic goal work from Goals.'
              : 'No other schedules yet.'}
          </EmptyState>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {directScheduleRows.map((s) => (
              <Card key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {scheduleLabels[s.name] ?? s.name.replaceAll('-', ' ')}
                    {s.enabled ? null : <CountBadge tone="amber">paused</CountBadge>}
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-500">
                    {s.nextRunAt && s.enabled
                      ? `Next ${relativeTime(s.nextRunAt, now)} (${formatDateTime(s.nextRunAt)})`
                      : 'Not currently scheduled'}
                    {s.lastRunAt ? ` · last ${relativeTime(s.lastRunAt, now)}` : ''}
                  </p>
                  <details className="mt-1 text-[11px] text-zinc-500">
                    <summary className="cursor-pointer">Technical schedule</summary>
                    <code>{s.cron}</code>
                  </details>
                </div>
                <form action={setScheduleEnabled.bind(null, s.id, !s.enabled)}>
                  <button type="submit" className={btn.outline}>
                    {s.enabled ? 'Pause' : 'Resume'}
                  </button>
                </form>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Costs */}
      <section>
        <SectionHeading title="Spending" hint="usage and limits live in one place" />
        <Card className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-700 dark:text-zinc-300">
            Review today’s usage, the monthly total, and adjust spending limits.
          </p>
          <Link href="/costs" className={btn.outline}>
            Open costs
          </Link>
        </Card>
      </section>

      {/* Approval rules */}
      <section>
        <SectionHeading
          title="Standing approval choices"
          count={policyRows.length}
          hint="actions the assistant can remember how to handle"
        />
        {policyRows.length === 0 ? (
          <EmptyState>
            No standing rules. Recipient-specific choices you save from an approval will appear
            here.
          </EmptyState>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {policyRows.map((p) => (
              <Card key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {policyLabels[p.templateKey] ?? 'Custom approval rule'}
                    <CountBadge tone={p.effect === 'allow' ? 'green' : 'amber'}>
                      {p.effect === 'allow' ? 'Allowed' : 'Blocked'}
                    </CountBadge>
                    {p.enabled ? null : <CountBadge>Paused</CountBadge>}
                  </p>
                  <details className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
                    <summary className="cursor-pointer">Technical details</summary>
                    <code>{p.toolName}</code> · {p.templateKey}
                  </details>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <form action={setPolicyEnabled.bind(null, p.id, !p.enabled)}>
                    <button type="submit" className={btn.outline}>
                      {p.enabled ? 'Pause rule' : 'Use rule'}
                    </button>
                  </form>
                  {p.createdVia !== 'seed' ? (
                    <form action={deletePolicy.bind(null, p.id)}>
                      <button
                        type="submit"
                        className={btn.dangerOutline}
                        title="Remove the rule — this tool goes back to asking for approval"
                      >
                        Delete
                      </button>
                    </form>
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
