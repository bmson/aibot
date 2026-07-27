import { getAgent } from '@assistant/core/chat';
import { agents, approvalPolicies, budgets, type Db, schedules } from '@assistant/db';
import { asc, eq, sql } from 'drizzle-orm';

export interface SettingsOverview {
  agent: Awaited<ReturnType<typeof getAgent>>;
  schedules: Array<typeof schedules.$inferSelect>;
  policies: Array<typeof approvalPolicies.$inferSelect>;
  goalAutomationCount: number;
}

export async function getSettingsOverview(db: Db): Promise<SettingsOverview> {
  const [agent, scheduleRows, policies] = await Promise.all([
    getAgent(db),
    db.select().from(schedules).orderBy(asc(schedules.name)),
    db.select().from(approvalPolicies).orderBy(asc(approvalPolicies.toolName)),
  ]);
  const directSchedules = scheduleRows.filter((schedule) => !schedule.name.startsWith('goal:'));
  return {
    agent,
    schedules: directSchedules,
    policies,
    goalAutomationCount: scheduleRows.length - directSchedules.length,
  };
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export async function updateAssistantSettings(
  db: Db,
  input: { timezone: string; locale: string; signature: string },
): Promise<{ error?: string }> {
  const timezone = input.timezone.trim();
  const locale = input.locale.trim().slice(0, 20);
  if (!isValidTimezone(timezone)) return { error: `Unknown timezone "${timezone}".` };
  if (!locale) return { error: 'Locale is required.' };
  const [agent] = await db.select({ id: agents.id }).from(agents).limit(1);
  if (!agent) return { error: 'No agent configured.' };
  await db
    .update(agents)
    .set({
      timezone,
      locale,
      signature: input.signature.trim().slice(0, 500),
      updatedAt: sql`now()`,
    })
    .where(eq(agents.id, agent.id));
  return {};
}

export async function setRecurringJobEnabled(
  db: Db,
  scheduleId: string,
  enabled: boolean,
): Promise<void> {
  await db
    .update(schedules)
    .set({ enabled, ...(enabled ? { nextRunAt: null } : {}), updatedAt: sql`now()` })
    .where(eq(schedules.id, scheduleId));
}

export async function updateSpendingBudgets(
  db: Db,
  values: Partial<Record<'task_default' | 'daily' | 'monthly', number>>,
): Promise<void> {
  for (const scope of ['task_default', 'daily', 'monthly'] as const) {
    const value = values[scope];
    if (!Number.isFinite(value) || !value || value <= 0 || value > 10_000) continue;
    await db
      .update(budgets)
      .set({ limitUsd: value.toFixed(2), updatedAt: sql`now()` })
      .where(eq(budgets.scope, scope));
  }
}

export async function setApprovalPolicyEnabled(
  db: Db,
  policyId: string,
  enabled: boolean,
): Promise<void> {
  await db.update(approvalPolicies).set({ enabled }).where(eq(approvalPolicies.id, policyId));
}

export async function deleteApprovalPolicy(db: Db, policyId: string): Promise<void> {
  await db.delete(approvalPolicies).where(eq(approvalPolicies.id, policyId));
}
