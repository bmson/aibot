import { getCostsDashboard, getProfileOverview } from '@assistant/application';
import { policyLabels, scheduleLabels } from '@/app/settings/labels';
import { getApplication, getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/**
 * Owner-only, native-ready projections for the secondary workspace surfaces.
 * Keep this separate from the chat bootstrap: chat needs to start immediately,
 * while these richer dashboards only load when their destination opens.
 */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();

  const application = getApplication();
  const db = getDb();
  const [currentChats, archivedChats, profile, skills, settings, costs, anomalies, improvements] =
    await Promise.all([
      application.listChatHistory(false),
      application.listChatHistory(true),
      getProfileOverview(db),
      application.listSkills(),
      application.getSettings(),
      getCostsDashboard(db),
      application.listAnomalies(),
      application.listImprovementProposals(),
    ]);

  return mobileJson({
    generatedAt: new Date().toISOString(),
    chats: {
      current: currentChats.conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        isPrimary: conversation.isPrimary,
        updatedAt: conversation.updatedAt,
        active: currentChats.activeConversationIds.includes(conversation.id),
      })),
      archived: archivedChats.conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        isPrimary: conversation.isPrimary,
        updatedAt: conversation.updatedAt,
        active: archivedChats.activeConversationIds.includes(conversation.id),
      })),
    },
    memory: {
      ownerName: profile.owner?.name ?? null,
      health: profile.memoryHealth,
      facts: profile.ownerFacts.slice(0, 80).map((fact) => ({
        id: fact.id,
        content: fact.content,
        kind: fact.kind,
        domain: fact.domain,
        ownerConfirmed: fact.ownerConfirmed,
        pinned: fact.pinned,
        importance: fact.importance,
        createdAt: fact.createdAt,
      })),
      awaitingReview: profile.quarantined.slice(0, 40).map((fact) => ({
        id: fact.id,
        content: fact.content,
        kind: fact.kind,
        domain: fact.domain,
        ownerConfirmed: fact.ownerConfirmed,
        pinned: fact.pinned,
        importance: fact.importance,
        createdAt: fact.createdAt,
      })),
      peopleCount: profile.people.length,
    },
    skills: skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      preconditions: skill.preconditions,
      steps: skill.steps,
      gotchas: skill.gotchas,
      ownerAuthored: skill.ownerAuthored,
      deprecated: skill.deprecated,
      useCount: skill.useCount,
      successCount: skill.successCount,
      failureCount: skill.failureCount,
      updatedAt: skill.updatedAt,
    })),
    settings: {
      agent: {
        name: settings.agent.name,
        timezone: settings.agent.timezone,
        locale: settings.agent.locale,
        signature: settings.agent.signature,
      },
      // `label` carries the same human wording the web settings page shows,
      // so the phone never has to keep its own copy of the dictionaries.
      schedules: settings.schedules.map((schedule) => ({
        id: schedule.id,
        name: schedule.name,
        label: scheduleLabels[schedule.name] ?? null,
        cron: schedule.cron,
        enabled: schedule.enabled,
        nextRunAt: schedule.nextRunAt,
        lastRunAt: schedule.lastRunAt,
      })),
      policies: settings.policies.map((policy) => ({
        id: policy.id,
        toolName: policy.toolName,
        templateKey: policy.templateKey,
        label: policyLabels[policy.templateKey] ?? null,
        effect: policy.effect,
        enabled: policy.enabled,
        createdVia: policy.createdVia,
      })),
      goalAutomationCount: settings.goalAutomationCount,
    },
    costs: {
      dailySpentUsd: costs.totals.dailySpentUsd,
      monthlySpentUsd: costs.totals.monthlySpentUsd,
      heldUsd: costs.totals.heldUsd,
      dailyLimitUsd: Number.isFinite(costs.totals.dailyLimitUsd)
        ? costs.totals.dailyLimitUsd
        : null,
      monthlyLimitUsd: Number.isFinite(costs.totals.monthlyLimitUsd)
        ? costs.totals.monthlyLimitUsd
        : null,
      taskDefaultLimit: costs.taskDefaultLimit,
      parkedTasks: costs.parkedTasks,
      bySource: costs.bySource,
      byModel: costs.byModel,
      held: costs.held,
      topTasks: costs.topTasks,
      recent: costs.recent,
    },
    anomalies: anomalies.map((anomaly) => ({
      id: anomaly.id,
      kind: anomaly.kind,
      toolName: anomaly.toolName,
      detail: anomaly.detail,
      observed: anomaly.observed,
      expected: anomaly.expected,
      citationCount: anomaly.toolCallIds.length,
      hasPolicy: anomaly.policyId !== null,
      createdAt: anomaly.createdAt,
    })),
    improvements: improvements.map((proposal) => {
      const change = (proposal.change ?? {}) as { suggestion?: unknown };
      return {
        id: proposal.id,
        kind: proposal.kind,
        title: proposal.title,
        rationale: proposal.rationale,
        suggestion: typeof change.suggestion === 'string' ? change.suggestion : '',
        evidenceCount: proposal.evidenceIds.length,
        applyable: proposal.kind === 'model_role',
        createdAt: proposal.createdAt,
      };
    }),
  });
}
