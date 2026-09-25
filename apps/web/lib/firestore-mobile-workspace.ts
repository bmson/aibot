import {
  getImportOverview,
  getProfileOverview,
  listMobileWorkspaceAnomalies,
  listMobileWorkspaceCapabilities,
  listMobileWorkspaceImprovements,
  listMobileWorkspaceSkills,
  projectMobileWorkspaceMemory,
} from '@assistant/application';
import { loadConfig } from '@assistant/config';
import {
  assertPrivacyErasureFenceUnchanged,
  FirestoreImportOverviewRepository,
  FirestoreProfileOverviewRepository,
  FirestoreWorkspaceAnomalyRepository,
  FirestoreWorkspaceCapabilityRepository,
  FirestoreWorkspaceImprovementRepository,
  getFirestoreMobileCosts,
  readPrivacyErasureFence,
} from '@assistant/firestore';
import { FirestoreSkillLibraryRepository } from '@assistant/firestore/skill-library';
import { assistantModuleMetas } from '@assistant/modules/meta';
import type { AgentReadinessSource } from '@assistant/persistence';
import { policyLabels, scheduleLabels } from '@/app/settings/labels';
import {
  getChatApplication,
  getFirestoreInstallationStore,
  getWorkspace,
  getWorkspaceSettings,
} from './server';

/** Compose the existing native workspace contract entirely from customer-owned stores. */
export async function getFirestoreMobileWorkspace(readinessSource: AgentReadinessSource) {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER !== 'firestore')
    throw new Error('Firestore mobile workspace requires Firestore persistence');
  const store = getFirestoreInstallationStore();
  const agentId = config.FIRESTORE_AGENT_ID;
  const privacyFence = await readPrivacyErasureFence(store, agentId);
  const chat = getChatApplication();
  const [
    currentChats,
    archivedChats,
    profile,
    skills,
    settings,
    costs,
    anomalies,
    improvements,
    imports,
    capabilities,
  ] = await Promise.all([
    chat.listChatHistory(false),
    chat.listChatHistory(true),
    getProfileOverview(new FirestoreProfileOverviewRepository(store, agentId)),
    listMobileWorkspaceSkills(new FirestoreSkillLibraryRepository(store), agentId),
    getWorkspaceSettings(),
    getFirestoreMobileCosts(store, agentId),
    listMobileWorkspaceAnomalies(new FirestoreWorkspaceAnomalyRepository(store), agentId),
    listMobileWorkspaceImprovements(new FirestoreWorkspaceImprovementRepository(store), agentId),
    getImportOverview(new FirestoreImportOverviewRepository(store, agentId), getWorkspace()),
    listMobileWorkspaceCapabilities(
      new FirestoreWorkspaceCapabilityRepository(store, agentId, readinessSource),
      agentId,
      assistantModuleMetas,
      config.ASSISTANT_MODULES,
    ),
  ]);

  const conversations = (history: typeof currentChats) =>
    history.conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      isPrimary: conversation.isPrimary,
      updatedAt: conversation.updatedAt,
      active: history.activeConversationIds.includes(conversation.id),
    }));

  // Each section checks its own scope. The outer fence also prevents a mixed
  // response if erasure starts between otherwise individually valid reads.
  await assertPrivacyErasureFenceUnchanged(store, agentId, privacyFence);

  return {
    generatedAt: new Date().toISOString(),
    chats: { current: conversations(currentChats), archived: conversations(archivedChats) },
    memory: projectMobileWorkspaceMemory(profile),
    skills,
    capabilities,
    settings: {
      agent: {
        name: settings.agent.name,
        timezone: settings.agent.timezone,
        locale: settings.agent.locale,
        signature: settings.agent.signature,
      },
      schedules: settings.schedules
        .filter((schedule) => !schedule.name.startsWith('reminder:'))
        .map((schedule) => ({
          id: schedule.id,
          name: schedule.name,
          label: scheduleLabels[schedule.name] ?? null,
          cron: schedule.cron,
          enabled: schedule.enabled,
          nextRunAt: schedule.nextRunAt,
          lastRunAt: schedule.lastRunAt,
        })),
      reminders: settings.reminders,
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
    anomalies,
    improvements,
    imports: {
      sources: imports.sources.map((source) => ({
        source: source.source,
        workspacePath: source.workspacePath,
        kind: source.kind,
        status: source.status,
        itemsTotal: source.itemsTotal,
        itemsProcessed: source.itemsProcessed,
        memoriesSaved: source.memoriesSaved,
        quarantinedNow: imports.quarantineBySource[source.source] ?? 0,
        taskId: source.taskId,
        error: source.error,
        updatedAt: source.updatedAt,
      })),
      unstartedFiles: imports.unstartedFiles,
    },
  };
}
