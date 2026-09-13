import type { Records } from './records.js';

/** Durable evidence read/write port used by the executor finalization funnel. */
export type ExecutionEvidenceRecord = Pick<
  Records['toolCalls'],
  'id' | 'toolName' | 'status' | 'args' | 'result' | 'error' | 'step'
>;

export type ResponseCheckInput = {
  taskId: string;
  promptVersion: number;
  plannerVersion: number | null;
  blocked: boolean;
  unsupportedCount: number;
  mustActRetries: number;
  degradedSteps: number;
  outputVerificationAttempted: boolean;
  outputVerificationRevised: boolean;
  outputVerificationUnavailable: boolean;
};

export type ExecutionEvidenceRepository = {
  kind: 'execution-evidence-repository';
  taskEvidence(input: {
    agentId: string;
    taskId: string;
    maxRows?: number;
  }): Promise<ExecutionEvidenceRecord[]>;
  conversationEvidence(input: {
    agentId: string;
    conversationId: string;
    excludeTaskId: string;
    maxRows?: number;
  }): Promise<ExecutionEvidenceRecord[]>;
  finalMessageExists(input: {
    agentId: string;
    taskId: string;
    conversationId: string | null;
    text: string;
  }): Promise<boolean>;
  hasOutboundReply(input: { agentId: string; taskId: string }): Promise<boolean>;
  checklistDecisions(input: {
    agentId: string;
    taskId: string;
  }): Promise<readonly { toolCallId: string; status: string }[]>;
  recordResponseCheck(input: { agentId: string; check: ResponseCheckInput }): Promise<boolean>;
};

export const DEFAULT_EXECUTION_EVIDENCE_LIMIT = 500;

export function evidenceLimit(maxRows: number | undefined): number {
  const value = maxRows ?? DEFAULT_EXECUTION_EVIDENCE_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_EXECUTION_EVIDENCE_LIMIT)
    throw new Error('Execution evidence limit is invalid');
  return value;
}
