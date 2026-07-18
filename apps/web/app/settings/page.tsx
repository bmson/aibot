import { getAgent } from '@assistant/core';
import { approvalPolicies, budgets, schedules } from '@assistant/db';
import { asc } from 'drizzle-orm';
import {
  deletePolicy,
  setPolicyEnabled,
  setScheduleEnabled,
  updateBudgets,
} from '@/app/settings/actions';
import { AgentForm } from '@/app/settings/agent-form';
import { requireOwner } from '@/auth';
import { formatDateTime, formatUsd, relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import {
  btn,
  Card,
  CountBadge,
  EmptyState,
  inputClass,
  labelClass,
  PageHeader,
  SectionHeading,
} from '@/lib/ui';

export const dynamic = 'force-dynamic';

const BUDGET_LABELS: Record<string, string> = {
  task_default: 'Per task (default)',
  daily: 'Per day',
  monthly: 'Per month',
};

export default async function SettingsPage() {
  await requireOwner();
  const db = getDb();
  const now = new Date();

  const [agent, scheduleRows, budgetRows, policyRows] = await Promise.all([
    getAgent(db),
    db.select().from(schedules).orderBy(asc(schedules.name)),
    db.select().from(budgets),
    db.select().from(approvalPolicies).orderBy(asc(approvalPolicies.toolName)),
  ]);
  const budgetByScope = new Map(budgetRows.map((b) => [b.scope, b]));
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
                    {s.name}
                    {s.enabled ? null : <CountBadge tone="amber">paused</CountBadge>}
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-500">
                    <code>{s.cron}</code>
                    {s.nextRunAt && s.enabled
                      ? ` · next ${relativeTime(s.nextRunAt, now)} (${formatDateTime(s.nextRunAt)})`
                      : ''}
                    {s.lastRunAt ? ` · last ${relativeTime(s.lastRunAt, now)}` : ''}
                  </p>
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

      {/* Budgets */}
      <section>
        <SectionHeading title="Spend caps" hint="hard limits; tasks park when exhausted" />
        <Card className="mt-3">
          <form action={updateBudgets} className="flex flex-wrap items-end gap-4">
            {(['task_default', 'daily', 'monthly'] as const).map((scope) => {
              const row = budgetByScope.get(scope);
              return (
                <label key={scope} className="flex flex-col gap-1">
                  <span className={labelClass}>{BUDGET_LABELS[scope]}</span>
                  <div className="flex items-center gap-1">
                    <span className="text-sm text-zinc-500">$</span>
                    <input
                      type="number"
                      name={scope}
                      step="0.01"
                      min="0.01"
                      defaultValue={row ? Number.parseFloat(row.limitUsd).toFixed(2) : ''}
                      className={`${inputClass} w-24`}
                    />
                  </div>
                </label>
              );
            })}
            <button type="submit" className={btn.outline}>
              Save caps
            </button>
          </form>
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
            Current:{' '}
            {['task_default', 'daily', 'monthly']
              .map((s) => `${BUDGET_LABELS[s]} ${formatUsd(budgetByScope.get(s)?.limitUsd)}`)
              .join(' · ')}
          </p>
        </Card>
      </section>

      {/* Approval rules */}
      <section>
        <SectionHeading
          title="Approval rules"
          count={policyRows.length}
          hint='standing "always allow / always deny" decisions'
        />
        {policyRows.length === 0 ? (
          <EmptyState>
            No standing rules — when you tick "always allow" on an approval, the rule shows up here.
          </EmptyState>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {policyRows.map((p) => (
              <Card key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <code>{p.toolName}</code>
                    <CountBadge tone={p.effect === 'allow' ? 'green' : 'amber'}>
                      {p.effect}
                    </CountBadge>
                    {p.enabled ? null : <CountBadge>disabled</CountBadge>}
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-500">
                    {p.templateKey} · created via {p.createdVia.replaceAll('_', ' ')}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <form action={setPolicyEnabled.bind(null, p.id, !p.enabled)}>
                    <button type="submit" className={btn.outline}>
                      {p.enabled ? 'Disable' : 'Enable'}
                    </button>
                  </form>
                  <form action={deletePolicy.bind(null, p.id)}>
                    <button
                      type="submit"
                      className={btn.dangerOutline}
                      title="Remove the rule — this tool goes back to asking for approval"
                    >
                      Delete
                    </button>
                  </form>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
