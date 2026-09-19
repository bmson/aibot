import type { ExecutionPersistence } from '@assistant/persistence';
import { createPostgresApprovalPolicyRepository } from './approval-policy-repository.js';
import { createPostgresApprovalRepository } from './approval-repository.js';
import { createPostgresCardRefreshRepository } from './card-refresh-repository.js';
import type { Db } from './client.js';
import { createPostgresCostRepository } from './cost-repository.js';
import { createPostgresExecutionContextRepository } from './execution-context-repository.js';
import { createPostgresExecutionEvidenceRepository } from './execution-evidence-repository.js';
import { createPostgresExecutionJobRepository } from './execution-jobs-repository.js';
import { createPostgresGeneratedCardRepository } from './generated-card-repository.js';
import { createPostgresGraphRecallRepository } from './graph-recall-repository.js';
import { createPostgresHistoryRecallRepository } from './history-recall-repository.js';
import { createPostgresMemorySupersedeRepository } from './memory-supersede-repository.js';
import { createPostgresMemoryToolRepository } from './memory-tool-repository.js';
import { createPostgresMessageRepository } from './message-repository.js';
import { createPostgresModelRoutingRepository } from './model-routing-repository.js';
import { createPostgresOwnerCardCompilationRepository } from './owner-card-compilation-repository.js';
import { createPostgresOwnerContextRepository } from './owner-context-repository.js';
import { createPostgresRecallMetricsRepository } from './recall-metrics-repository.js';
import { createPostgresSkillContextRepository } from './skill-context-repository.js';
import { createPostgresTaskRepository } from './task-lifecycle-repository.js';
import { createPostgresToolExecutionRepository } from './tool-execution-repository.js';
import { createPostgresWatchRepository } from './watch-repository.js';

export function createPostgresExecutionPersistence(db: Db): ExecutionPersistence {
  return {
    driver: 'postgres',
    tasks: createPostgresTaskRepository(db),
    costs: createPostgresCostRepository(db),
    messages: createPostgresMessageRepository(db),
    memory: createPostgresMemoryToolRepository(db),
    memorySupersede: createPostgresMemorySupersedeRepository(db),
    approvals: createPostgresApprovalRepository(db),
    approvalPolicies: createPostgresApprovalPolicyRepository(db),
    modelRouting: createPostgresModelRoutingRepository(db),
    toolExecution: createPostgresToolExecutionRepository(db),
    executionContext: createPostgresExecutionContextRepository(db),
    executionJobs: createPostgresExecutionJobRepository(db),
    executionEvidence: createPostgresExecutionEvidenceRepository(db),
    ownerContext: createPostgresOwnerContextRepository(db),
    ownerCardCompilation: createPostgresOwnerCardCompilationRepository(db),
    skills: createPostgresSkillContextRepository(db),
    history: createPostgresHistoryRecallRepository(db),
    graph: createPostgresGraphRecallRepository(db),
    generatedCards: createPostgresGeneratedCardRepository(db),
    cardRefresh: createPostgresCardRefreshRepository(db),
    recallMetrics: createPostgresRecallMetricsRepository(db),
    watches: createPostgresWatchRepository(db),
  };
}
