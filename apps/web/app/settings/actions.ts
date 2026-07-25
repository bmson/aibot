'use server';

import { getAgent } from '@assistant/core';
import { agents, approvalPolicies, budgets, schedules } from '@assistant/db';
import { asc, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { formatDateTime, relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import { policyLabels, policyScope, scheduleLabels } from './labels';

function revalidateSettings(): void {
  revalidatePath('/settings');
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Editable agent identity: timezone, locale, signature. */
export async function updateAgentSettings(input: {
  timezone: string;
  locale: string;
  signature: string;
}): Promise<{ error?: string }> {
  await requireOwner();
  const timezone = input.timezone.trim();
  const locale = input.locale.trim().slice(0, 20);
  if (!isValidTimezone(timezone)) return { error: `Unknown timezone "${timezone}".` };
  if (locale.length === 0) return { error: 'Locale is required.' };

  const db = getDb();
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
  revalidateSettings();
  return {};
}

/** Pause/resume a proactive schedule. Re-enabling recomputes next_run_at on the next sweep. */
export async function setScheduleEnabled(scheduleId: string, enabled: boolean): Promise<void> {
  await requireOwner();
  await getDb()
    .update(schedules)
    .set({ enabled, ...(enabled ? { nextRunAt: null } : {}), updatedAt: sql`now()` })
    .where(eq(schedules.id, scheduleId));
  revalidateSettings();
}

/** Update spend caps for all three scopes; invalid or out-of-range values are skipped. */
export async function updateBudgets(formData: FormData): Promise<void> {
  await requireOwner();
  const db = getDb();
  for (const scope of ['task_default', 'daily', 'monthly'] as const) {
    const value = Number.parseFloat(String(formData.get(scope) ?? '').trim());
    if (!Number.isFinite(value) || value <= 0 || value > 10000) continue;
    await db
      .update(budgets)
      .set({ limitUsd: value.toFixed(2), updatedAt: sql`now()` })
      .where(eq(budgets.scope, scope));
  }
  revalidateSettings();
  revalidatePath('/costs');
}

/** Enable/disable a standing approval rule. */
export async function setPolicyEnabled(policyId: string, enabled: boolean): Promise<void> {
  await requireOwner();
  await getDb().update(approvalPolicies).set({ enabled }).where(eq(approvalPolicies.id, policyId));
  revalidateSettings();
}

/** Remove a standing approval rule entirely — the tool goes back to asking. */
export async function deletePolicy(policyId: string): Promise<void> {
  await requireOwner();
  await getDb().delete(approvalPolicies).where(eq(approvalPolicies.id, policyId));
  revalidateSettings();
}

export interface SettingsSummary {
  agent: { name: string; email: string; timezone: string };
  schedules: Array<{ id: string; title: string; enabled: boolean; detail: string }>;
  goalAutomationCount: number;
  policies: Array<{
    id: string;
    title: string;
    allowed: boolean;
    enabled: boolean;
    scope: string | null;
  }>;
}

/**
 * Read-only settings digest for the collapsed-rail popover. Fetched on demand
 * (only when that popover opens) rather than joined into every page's data —
 * the full settings page already pays for these queries when it's the one
 * being viewed; nothing else needs to.
 */
export async function getSettingsSummary(): Promise<SettingsSummary> {
  await requireOwner();
  const db = getDb();
  const now = new Date();
  const [agent, scheduleRows, policyRows] = await Promise.all([
    getAgent(db),
    db.select().from(schedules).orderBy(asc(schedules.name)),
    db.select().from(approvalPolicies).orderBy(asc(approvalPolicies.toolName)),
  ]);
  const directScheduleRows = scheduleRows.filter((s) => !s.name.startsWith('goal:'));

  return {
    agent: { name: agent.name, email: agent.email, timezone: agent.timezone },
    schedules: directScheduleRows.map((s) => ({
      id: s.id,
      title: scheduleLabels[s.name] ?? s.name.replaceAll('-', ' '),
      enabled: s.enabled,
      detail: !s.enabled
        ? 'Not scheduled'
        : !s.nextRunAt
          ? 'Recalculating on the next sweep'
          : s.nextRunAt <= now
            ? `Overdue since ${formatDateTime(s.nextRunAt, agent.timezone)}`
            : `Next ${relativeTime(s.nextRunAt, now)}`,
    })),
    goalAutomationCount: scheduleRows.length - directScheduleRows.length,
    policies: policyRows.map((p) => ({
      id: p.id,
      title: policyLabels[p.templateKey] ?? 'Custom approval rule',
      allowed: p.effect === 'allow',
      enabled: p.enabled,
      scope: policyScope(p.templateKey, p.match),
    })),
  };
}
