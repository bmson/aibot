import type { ApprovalPolicyRepository } from './approval-policies.js';
import type { ApprovalRepository } from './approvals.js';
import type { CostRepository, MessageRepository } from './contracts.js';
import type { ToolExecutionRepository } from './dispatch.js';
import type { ExecutionContextRepository } from './execution-context.js';
import type { ExecutionEvidenceRepository } from './execution-evidence.js';
import type { ExecutionJobRepository } from './execution-jobs.js';
import type { ModelRoutingRepository } from './model-routing.js';
import type { OwnerContextRepository } from './owner-context.js';
import type { SkillContextRepository } from './skill-context.js';
import type { TaskRepository } from './task-lifecycle.js';

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
  readonly skills: SkillContextRepository;
}
