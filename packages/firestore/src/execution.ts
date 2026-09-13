import type { EmbeddingSpace, ExecutionPersistence } from '@assistant/persistence';
import { FirestoreApprovalPolicyRepository } from './approval-policies.js';
import { FirestoreApprovalRepository } from './approvals.js';
import { FirestoreCostRepository } from './costs.js';
import { FirestoreExecutionContextRepository } from './execution-context.js';
import { FirestoreExecutionEvidenceRepository } from './execution-evidence.js';
import { FirestoreExecutionJobRepository } from './execution-jobs.js';
import { FirestoreMessageRepository } from './messages.js';
import { FirestoreModelRoutingRepository } from './model-routing.js';
import { FirestoreOwnerContextRepository } from './owner-context.js';
import { FirestoreSkillContextRepository } from './skill-context.js';
import type { InstallationStore } from './store.js';
import { FirestoreTaskRepository } from './task-lifecycle.js';
import { FirestoreToolExecutionRepository } from './tool-execution.js';

/** Composes migrated operations only; this is not a complete application driver switch. */
export function createFirestoreExecutionPersistence(
  store: InstallationStore,
  agentId: string,
  skillEmbeddingSpace: EmbeddingSpace,
): ExecutionPersistence {
  return {
    driver: 'firestore',
    tasks: new FirestoreTaskRepository(store),
    costs: new FirestoreCostRepository(store),
    messages: new FirestoreMessageRepository(store),
    approvals: new FirestoreApprovalRepository(store),
    approvalPolicies: new FirestoreApprovalPolicyRepository(store),
    modelRouting: new FirestoreModelRoutingRepository(store, agentId),
    toolExecution: new FirestoreToolExecutionRepository(store),
    executionContext: new FirestoreExecutionContextRepository(store),
    executionJobs: new FirestoreExecutionJobRepository(store),
    executionEvidence: new FirestoreExecutionEvidenceRepository(store),
    ownerContext: new FirestoreOwnerContextRepository(store),
    skills: new FirestoreSkillContextRepository(store, skillEmbeddingSpace),
  };
}
