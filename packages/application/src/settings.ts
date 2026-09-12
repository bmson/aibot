import {
  cancelReminderSchedule,
  listOwnerSchedules,
  reminderScheduleIsActive,
  reminderScheduleTemplate,
} from '@assistant/core';
import { getAgent } from '@assistant/core/chat';
import { countHeldPings } from '@assistant/core/proactive/nudge-policy';
import {
  type ApprovalPolicy,
  type ApprovalPolicyRepository,
  deleteApprovalPolicyForAgent,
  listApprovalPolicies,
  setApprovalPolicyEnabledForAgent,
} from '@assistant/core/workflow/approval-policies';
import { agents, type Db, notificationPrefs, schedules } from '@assistant/db';
import { and, eq, notLike, sql } from 'drizzle-orm';

export interface NotificationPrefsView {
  /** "HH:MM" owner-local, or empty when quiet hours are off. */
  quietStart: string;
  quietEnd: string;
  /** Empty when there is no cap. */
  ambientDailyCap: string;
  /** Pings the policy held back over the last day, by reason. */
  heldLast24h: { quietHours: number; dailyCap: number };
}

export interface SettingsOverview {
  agent: Awaited<ReturnType<typeof getAgent>>;
  schedules: Array<typeof schedules.$inferSelect>;
  reminders: Array<{
    id: string;
    text: string;
    kind: 'once' | 'recurring';
    status: 'scheduled' | 'delivering';
    nextRunAt: Date | null;
  }>;
  policies: ApprovalPolicy[];
  goalAutomationCount: number;
  notificationPrefs: NotificationPrefsView;
}

function minutesToHHMM(minutes: number | null): string {
  if (minutes == null) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** "HH:MM" → minutes after midnight; empty string → null (field off). */
function parseHHMM(value: string): { ok: true; minutes: number | null } | { ok: false } {
  const trimmed = value.trim();
  if (trimmed === '') return { ok: true, minutes: null };
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) return { ok: false };
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return { ok: false };
  return { ok: true, minutes: hours * 60 + minutes };
}

export async function getSettingsOverview(db: Db): Promise<SettingsOverview> {
  const agentPromise = getAgent(db);
  const [agent, scheduleRows, policies, prefsRows] = await Promise.all([
    agentPromise,
    agentPromise.then(async (agent) =>
      (await listOwnerSchedules(db, agent.id)).sort(
        (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      ),
    ),
    agentPromise.then((agent) => listApprovalPolicies(db, agent.id)),
    db.select().from(notificationPrefs),
  ]);
  const reminderSchedules = scheduleRows.filter((schedule) =>
    schedule.name.startsWith('reminder:'),
  );
  const directSchedules = scheduleRows.filter(
    (schedule) => !schedule.name.startsWith('goal:') && !schedule.name.startsWith('reminder:'),
  );
  const reminders = reminderSchedules.filter(reminderScheduleIsActive).map((schedule) => {
    const template = reminderScheduleTemplate(schedule.taskTemplate);
    return {
      id: schedule.id,
      text: template.reminderText ?? '',
      kind: template.reminderKind ?? ('recurring' as const),
      status: schedule.enabled ? ('scheduled' as const) : ('delivering' as const),
      nextRunAt: schedule.nextRunAt,
    };
  });
  const prefs = prefsRows.find((row) => row.agentId === agent.id);
  const heldLast24h = await countHeldPings(db, agent.id, new Date(Date.now() - 24 * 3600 * 1000));
  return {
    agent,
    schedules: directSchedules,
    reminders,
    policies,
    goalAutomationCount: scheduleRows.filter((schedule) => schedule.name.startsWith('goal:'))
      .length,
    notificationPrefs: {
      quietStart: minutesToHHMM(prefs?.quietStartMin ?? null),
      quietEnd: minutesToHHMM(prefs?.quietEndMin ?? null),
      ambientDailyCap: prefs?.ambientDailyCap != null ? String(prefs.ambientDailyCap) : '',
      heldLast24h,
    },
  };
}

export async function updateNotificationPrefs(
  db: Db,
  input: { quietStart: string; quietEnd: string; ambientDailyCap: string },
): Promise<{ error?: string }> {
  const start = parseHHMM(input.quietStart);
  const end = parseHHMM(input.quietEnd);
  if (!start.ok || !end.ok) return { error: 'Quiet hours need HH:MM times, or be left empty.' };
  // Half a window is off, not an accident: treat either side empty as no
  // quiet hours at all rather than guessing a 00:00 boundary.
  const quietStartMin = start.minutes != null && end.minutes != null ? start.minutes : null;
  const quietEndMin = start.minutes != null && end.minutes != null ? end.minutes : null;

  const capRaw = input.ambientDailyCap.trim();
  let ambientDailyCap: number | null = null;
  if (capRaw !== '') {
    const parsed = Number(capRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      return { error: 'The daily ping limit must be a whole number between 1 and 100.' };
    }
    ambientDailyCap = parsed;
  }

  const [agent] = await db.select({ id: agents.id }).from(agents).limit(1);
  if (!agent) return { error: 'No agent configured.' };
  await db
    .insert(notificationPrefs)
    .values({ agentId: agent.id, quietStartMin, quietEndMin, ambientDailyCap })
    .onConflictDoUpdate({
      target: notificationPrefs.agentId,
      set: { quietStartMin, quietEndMin, ambientDailyCap, updatedAt: sql`now()` },
    });
  return {};
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
): Promise<boolean> {
  const agent = await getAgent(db);
  const [updated] = await db
    .update(schedules)
    .set({ enabled, ...(enabled ? { nextRunAt: null } : {}), updatedAt: sql`now()` })
    .where(
      and(
        eq(schedules.id, scheduleId),
        eq(schedules.agentId, agent.id),
        notLike(schedules.name, 'reminder:%'),
      ),
    )
    .returning({ id: schedules.id });
  return Boolean(updated);
}

export async function deleteReminder(db: Db, reminderId: string): Promise<boolean> {
  const agent = await getAgent(db);
  return (await cancelReminderSchedule(db, agent.id, reminderId)).cancelled;
}

/** Composition supplies the authenticated installation owner for the portable path. */
export interface ApprovalPolicySettingsStore {
  agentId: string;
  policies: ApprovalPolicyRepository;
}

async function policyContext(store: Db | ApprovalPolicySettingsStore) {
  if ('policies' in store) return { agentId: store.agentId, repository: store.policies };
  return { agentId: (await getAgent(store)).id, repository: store };
}

export async function getApprovalPolicySettings(store: Db | ApprovalPolicySettingsStore) {
  const context = await policyContext(store);
  return listApprovalPolicies(context.repository, context.agentId);
}

export async function setApprovalPolicyEnabled(
  store: Db | ApprovalPolicySettingsStore,
  policyId: string,
  enabled: boolean,
): Promise<void> {
  const context = await policyContext(store);
  await setApprovalPolicyEnabledForAgent(context.repository, context.agentId, policyId, enabled);
}

export async function deleteApprovalPolicy(
  store: Db | ApprovalPolicySettingsStore,
  policyId: string,
): Promise<void> {
  const context = await policyContext(store);
  await deleteApprovalPolicyForAgent(context.repository, context.agentId, policyId);
}
