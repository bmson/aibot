import type { ExecutionPersistence } from '@assistant/persistence';
import { createPostgresApprovalPolicyRepository } from './approval-policy-repository.js';
import { createPostgresApprovalRepository } from './approval-repository.js';
import type { Db } from './client.js';
import { createPostgresCostRepository } from './cost-repository.js';
import { createPostgresExecutionContextRepository } from './execution-context-repository.js';
import { createPostgresExecutionEvidenceRepository } from './execution-evidence-repository.js';
import { createPostgresExecutionJobRepository } from './execution-jobs-repository.js';
import { createPostgresMessageRepository } from './message-repository.js';
import { createPostgresModelRoutingRepository } from './model-routing-repository.js';
import { createPostgresOwnerContextRepository } from './owner-context-repository.js';
import { createPostgresSkillContextRepository } from './skill-context-repository.js';
import { createPostgresTaskRepository } from './task-lifecycle-repository.js';
import { createPostgresToolExecutionRepository } from './tool-execution-repository.js';

export function createPostgresExecutionPersistence(db: Db): ExecutionPersistence {
  return {
    driver: 'postgres',
    tasks: createPostgresTaskRepository(db),
    costs: createPostgresCostRepository(db),
    messages: createPostgresMessageRepository(db),
    approvals: createPostgresApprovalRepository(db),
    approvalPolicies: createPostgresApprovalPolicyRepository(db),
    modelRouting: createPostgresModelRoutingRepository(db),
    toolExecution: createPostgresToolExecutionRepository(db),
    executionContext: createPostgresExecutionContextRepository(db),
    executionJobs: createPostgresExecutionJobRepository(db),
    executionEvidence: createPostgresExecutionEvidenceRepository(db),
    ownerContext: createPostgresOwnerContextRepository(db),
    skills: createPostgresSkillContextRepository(db),
  };
}
