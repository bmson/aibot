import type { ApprovalPolicyRepository } from './approval-policies.js';
import type { ApprovalRepository } from './approvals.js';
import type { CardRefreshRepository } from './card-refresh.js';
import type { CostRepository, MessageRepository } from './contracts.js';
import type { ToolExecutionRepository } from './dispatch.js';
import type { ExecutionContextRepository } from './execution-context.js';
import type { ExecutionEvidenceRepository } from './execution-evidence.js';
import type { ExecutionJobRepository } from './execution-jobs.js';
import type { GeneratedCardRepository } from './generated-cards.js';
import type { GraphRecallRepository } from './graph-recall.js';
import type { HistoryRecallRepository } from './history-recall.js';
import type { KnowledgeGraphSyncRepository } from './knowledge-graph-sync.js';
import type { MemorySupersedeRepository } from './memory-supersede.js';
import type { MemoryToolRepository } from './memory-tools.js';
import type { ModelRoutingRepository } from './model-routing.js';
import type { OwnerCardCompilationRepository } from './owner-card-compilation.js';
import type { OwnerContextRepository } from './owner-context.js';
import type { RecallMetricsRepository } from './recall-metrics.js';
import type { SkillContextRepository } from './skill-context.js';
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
  readonly graph: GraphRecallRepository;
  readonly graphSync: KnowledgeGraphSyncRepository;
  readonly generatedCards: GeneratedCardRepository;
  readonly cardRefresh: CardRefreshRepository;
  readonly recallMetrics: RecallMetricsRepository;
  readonly watches: WatchRepository;
}
