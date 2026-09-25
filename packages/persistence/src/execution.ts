import type { ApprovalPolicyRepository } from './approval-policies.js';
import type { ApprovalRepository } from './approvals.js';
import type { AssistantHealthRepository } from './assistant-health.js';
import type { BriefingRepository } from './briefing.js';
import type { CardRefreshRepository } from './card-refresh.js';
import type { CommitmentMaintenanceRepository } from './commitment-maintenance.js';
import type { CostRepository, MessageRepository } from './contracts.js';
import type { ConversationSegmentationRepository } from './conversation-segmentation.js';
import type { ToolExecutionRepository } from './dispatch.js';
import type { ExecutionContextRepository } from './execution-context.js';
import type { ExecutionEvidenceRepository } from './execution-evidence.js';
import type { ExecutionJobRepository } from './execution-jobs.js';
import type { GeneratedCardRepository } from './generated-cards.js';
import type { GoalRuntimeRepository } from './goals.js';
import type { GraphRecallRepository } from './graph-recall.js';
import type { HistoryRecallRepository } from './history-recall.js';
import type { KnowledgeGraphSyncRepository } from './knowledge-graph-sync.js';
import type { MaintenanceRepository } from './maintenance.js';
import type { MemoryConsolidationRepository } from './memory-consolidation.js';
import type { MemoryExtractionRepository } from './memory-extraction.js';
import type { MemorySupersedeRepository } from './memory-supersede.js';
import type { MemoryToolRepository } from './memory-tools.js';
import type { MissionRepository } from './missions.js';
import type { ModelRoutingRepository } from './model-routing.js';
import type {
  NotificationsConversationRepository,
  OwnerNoticeRepository,
} from './notifications.js';
import type { OwnerCardCompilationRepository } from './owner-card-compilation.js';
import type { AmbientSnapshotRepository, OwnerContextRepository } from './owner-context.js';
import type { PulseRepository } from './pulse.js';
import type { RecallMetricsRepository } from './recall-metrics.js';
import type { ReminderDeliveryRepository } from './reminders.js';
import type { SkillContextRepository } from './skill-context.js';
import type { SuggestionRepository } from './suggestions.js';
import type { TaskRepository } from './task-lifecycle.js';
import type { WatchRepository } from './watches.js';

/** One store supplies every migrated executor operation. Remaining domain ports are separate. */
export interface ExecutionPersistence {
  readonly driver: 'postgres' | 'firestore';
  readonly tasks: TaskRepository;
  readonly costs: CostRepository;
  readonly messages: MessageRepository;
  readonly approvals: ApprovalRepository;
  readonly approvalPolicies: ApprovalPolicyRepository;
  readonly modelRouting: ModelRoutingRepository;
  readonly toolExecution: ToolExecutionRepository;
  readonly executionContext: ExecutionContextRepository;
  readonly executionJobs: ExecutionJobRepository;
  readonly executionEvidence: ExecutionEvidenceRepository;
  readonly ownerContext: OwnerContextRepository;
  readonly ownerCardCompilation: OwnerCardCompilationRepository;
  readonly skills: SkillContextRepository;
  readonly history: HistoryRecallRepository;
  readonly memory: MemoryToolRepository;
  readonly memorySupersede: MemorySupersedeRepository;
  /** Present while the bounded consolidation job is migrated off SQL. */
  readonly memoryConsolidation?: MemoryConsolidationRepository;
  /** Present where the nightly `memory.extract` job has a portable adapter. */
  readonly memoryExtraction?: MemoryExtractionRepository;
  readonly graph: GraphRecallRepository;
  readonly graphSync: KnowledgeGraphSyncRepository;
  readonly generatedCards: GeneratedCardRepository;
  readonly cardRefresh: CardRefreshRepository;
  readonly recallMetrics: RecallMetricsRepository;
  readonly watches: WatchRepository;
  readonly notifications: NotificationsConversationRepository;
  readonly goals: GoalRuntimeRepository;
  readonly missions: MissionRepository;
  /** Present where the health monitor job has a portable adapter. */
  readonly assistantHealth?: AssistantHealthRepository;
  /**
   * Present where scheduled reminder delivery has a portable adapter. Without
   * it the `reminder.notify` job keeps its PostgreSQL delivery path.
   */
  readonly reminderDelivery?: ReminderDeliveryRepository;
  /**
   * Present where the maintenance sweep has a portable adapter. PostgreSQL
   * runs the same steps through the core SQL functions.
   */
  readonly maintenance?: MaintenanceRepository;
  /** Present where the ambient refresh job has a portable writer. */
  readonly ambientSnapshots?: AmbientSnapshotRepository;
  /** Present where the open-loop sweep has a portable adapter. */
  readonly commitmentMaintenance?: CommitmentMaintenanceRepository;
  /** Present where background producers post their dashboard copy portably. */
  readonly ownerNotices?: OwnerNoticeRepository;
  /** Present where producers record one-tap suggestions portably. */
  readonly suggestions?: SuggestionRepository;
  /** Present where the `briefing.compose` job has a portable adapter. */
  readonly briefing?: BriefingRepository;
  /** Present where the `pulse.check` job has a portable adapter. */
  readonly pulse?: PulseRepository;
  /** Present where the `chat.segment` job has a portable adapter. */
  readonly conversationSegmentation?: ConversationSegmentationRepository;
}
