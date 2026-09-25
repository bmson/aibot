import type { EmbeddingSpace, ExecutionPersistence } from '@assistant/persistence';
import { FirestoreAmbientSnapshotRepository } from './ambient-snapshots.js';
import { FirestoreApprovalPolicyRepository } from './approval-policies.js';
import { FirestoreApprovalRepository } from './approvals.js';
import { FirestoreAssistantHealthRepository } from './assistant-health.js';
import { createFirestoreCardRefreshRepository } from './card-refresh.js';
import { FirestoreCommitmentMaintenanceRepository } from './commitment-maintenance.js';
import { FirestoreCostRepository } from './costs.js';
import { FirestoreDeviceTokenRepository } from './device-tokens.js';
import { FirestoreExecutionContextRepository } from './execution-context.js';
import { FirestoreExecutionEvidenceRepository } from './execution-evidence.js';
import { FirestoreExecutionJobRepository } from './execution-jobs.js';
import { FirestoreGeneratedCardRepository } from './generated-cards.js';
import { FirestoreGoalRuntimeRepository } from './goal-runtime.js';
import { FirestoreGraphRecallRepository } from './graph-recall.js';
import { FirestoreHistoryRecallRepository } from './history-recall.js';
import { FirestoreKnowledgeGraphSyncRepository } from './knowledge-graph-sync.js';
import { FirestoreMemoryConsolidationRepository } from './memory-consolidation.js';
import { FirestoreMemorySupersedeRepository } from './memory-supersede.js';
import { FirestoreMemoryToolRepository } from './memory-tools.js';
import { FirestoreMessageRepository } from './messages.js';
import { FirestoreMissionRepository } from './missions.js';
import { FirestoreModelRoutingRepository } from './model-routing.js';
import { FirestoreNudgePolicyRepository } from './nudge-policy.js';
import { FirestoreOwnerCardCompilationRepository } from './owner-card-compilation.js';
import { FirestoreOwnerContextRepository } from './owner-context.js';
import { FirestoreOwnerNoticeRepository } from './owner-notices.js';
import { FirestoreRecallMetricsRepository } from './recall-metrics.js';
import { FirestoreReminderDeliveryRepository } from './reminders.js';
import { FirestoreSkillContextRepository } from './skill-context.js';
import { FirestoreSmsChannelRepository } from './sms-channel.js';
import type { InstallationStore } from './store.js';
import { FirestoreTaskRepository } from './task-lifecycle.js';
import { FirestoreToolExecutionRepository } from './tool-execution.js';
import { FirestoreVoiceContextRepository } from './voice-context.js';
import { FirestoreWatchRepository } from './watches.js';

/** Composes migrated operations only; this is not a complete application driver switch. */
export function createFirestoreExecutionPersistence(
  store: InstallationStore,
  agentId: string,
  skillEmbeddingSpace: EmbeddingSpace,
): ExecutionPersistence & { tasks: FirestoreTaskRepository } {
  return {
    driver: 'firestore',
    tasks: new FirestoreTaskRepository(store),
    costs: new FirestoreCostRepository(store),
    messages: new FirestoreMessageRepository(store),
    memory: new FirestoreMemoryToolRepository(store, skillEmbeddingSpace),
    memorySupersede: new FirestoreMemorySupersedeRepository(store, skillEmbeddingSpace),
    memoryConsolidation: new FirestoreMemoryConsolidationRepository(store, skillEmbeddingSpace),
    approvals: new FirestoreApprovalRepository(store),
    approvalPolicies: new FirestoreApprovalPolicyRepository(store),
    modelRouting: new FirestoreModelRoutingRepository(store, agentId),
    toolExecution: new FirestoreToolExecutionRepository(store),
    executionContext: new FirestoreExecutionContextRepository(store),
    executionJobs: new FirestoreExecutionJobRepository(store),
    executionEvidence: new FirestoreExecutionEvidenceRepository(store),
    ownerContext: new FirestoreOwnerContextRepository(store),
    ownerCardCompilation: new FirestoreOwnerCardCompilationRepository(store),
    skills: new FirestoreSkillContextRepository(store, skillEmbeddingSpace),
    history: new FirestoreHistoryRecallRepository(store, skillEmbeddingSpace),
    graph: new FirestoreGraphRecallRepository(store, skillEmbeddingSpace),
    graphSync: new FirestoreKnowledgeGraphSyncRepository(store),
    generatedCards: new FirestoreGeneratedCardRepository(store),
    cardRefresh: createFirestoreCardRefreshRepository(store),
    recallMetrics: new FirestoreRecallMetricsRepository(store),
    watches: new FirestoreWatchRepository(store),
    assistantHealth: new FirestoreAssistantHealthRepository(store, agentId),
    reminderDelivery: new FirestoreReminderDeliveryRepository(store, agentId),
    notifications: new FirestoreOwnerNoticeRepository(store, agentId),
    goals: new FirestoreGoalRuntimeRepository(store, agentId),
    missions: new FirestoreMissionRepository(store, agentId),
    ambientSnapshots: new FirestoreAmbientSnapshotRepository(store),
    commitmentMaintenance: new FirestoreCommitmentMaintenanceRepository(store),
    deviceTokens: new FirestoreDeviceTokenRepository(store),
    nudgePolicy: new FirestoreNudgePolicyRepository(store, agentId),
    voiceContext: new FirestoreVoiceContextRepository(store, agentId, skillEmbeddingSpace),
    smsChannel: new FirestoreSmsChannelRepository(store, agentId),
  };
}
