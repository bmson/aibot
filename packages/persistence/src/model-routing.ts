import type { CostRepository } from './contracts.js';
import type { Records } from './records.js';

type OptionalCallFields = 'taskId' | 'latencyMs' | 'finishReason' | 'openrouterGenerationId';
export type ModelCallWrite = Omit<Records['modelCalls'], 'id' | 'createdAt' | OptionalCallFields> &
  Partial<Pick<Records['modelCalls'], OptionalCallFields>>;
type OptionalAuditFields = 'modelCallId' | 'taskId' | 'finishReason' | 'latencyMs';
export type ModelAuditWrite = Omit<
  Records['modelCallAudit'],
  'id' | 'createdAt' | OptionalAuditFields
> &
  Partial<Pick<Records['modelCallAudit'], OptionalAuditFields>>;

/** Routing configuration and telemetry within one installation's accounting boundary. */
export interface ModelRoutingRepository {
  readonly kind: 'model-routing-repository';
  readonly costs: CostRepository;
  taskBudget(taskId: string): Promise<{ limit: string; spent: string } | null>;
  conversationOverride(taskId: string): Promise<string | null>;
  role(role: string): Promise<Records['modelRoles'] | null>;
  model(modelId: string): Promise<Records['models'] | null>;
  recordCall(input: ModelCallWrite): Promise<string>;
  recordAudit(input: ModelAuditWrite): Promise<void>;
}
