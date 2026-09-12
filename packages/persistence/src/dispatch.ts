import type { Records } from './records.js';

export interface WakeIntent {
  id: string;
  taskId: string;
  generation: number;
  availableAt: Date;
  status: 'pending' | 'leased' | 'delivered';
  attempts: number;
  leaseToken: string | null;
  lockedUntil: Date | null;
}
export type OutboxLease = WakeIntent & { status: 'leased'; leaseToken: string; lockedUntil: Date };
export interface DispatchOutbox {
  due(batch?: number): Promise<string[]>;
  claim(id: string): Promise<OutboxLease | null>;
  acknowledge(lease: OutboxLease): Promise<boolean>;
  retry(lease: OutboxLease): Promise<boolean>;
}
/** Resolve only after the provider has accepted this stable task/generation name. */
export interface TaskQueue {
  enqueue(taskId: string, generation: number, signal?: AbortSignal): Promise<void>;
}

export interface ApprovedToolCall {
  toolCall: Records['toolCalls'];
  task: Records['tasks'];
  approval: Records['approvals'] | null;
}

export interface ClaimApprovedToolCallInput {
  agentId: string;
  taskId: string;
  toolCallId: string;
  args: Record<string, unknown>;
  decision: Record<string, unknown>;
  expectedApprovalId?: string | null;
  expectedResolutionPayload?: unknown;
  startedAt?: Date;
}

export interface ToolExecutionOutcome {
  agentId: string;
  taskId: string;
  toolCallId: string;
  status: 'succeeded' | 'failed';
  fromStatus?: 'approved' | 'executing';
  result?: unknown;
  error?: string;
  finishedAt?: Date;
}
export interface StartAutonomousToolCallInput {
  agentId: string;
  taskId: string;
  step: number;
  toolName: string;
  args: Record<string, unknown>;
  idempotencyKey: string | null;
  decision: Record<string, unknown>;
  startedAt?: Date;
}
export interface CachedToolCallInput extends StartAutonomousToolCallInput {
  result: unknown;
}

/** Owner- and task-scoped persistence for the already-approved execution path. */
export interface ToolExecutionRepository {
  readonly kind: 'tool-execution-repository';
  /** Load a call and its links without returning another owner's records. */
  load(agentId: string, taskId: string, toolCallId: string): Promise<ApprovedToolCall | null>;
  /** Atomically transition this exact approved call to executing. */
  claim(input: ClaimApprovedToolCallInput): Promise<ApprovedToolCall | null>;
  /** Persist a terminal outcome only for the owner-linked call. */
  outcome(input: ToolExecutionOutcome): Promise<boolean>;
  contacts(): Promise<Array<{ emails: string[]; phones: string[] }>>;
  underRateLimit(scope: string, toolName: string, now?: Date): Promise<boolean>;
  cacheGet(cacheKey: string, now?: Date): Promise<{ result: unknown } | null>;
  cachePut(input: {
    cacheKey: string;
    toolName: string;
    result: unknown;
    expiresAt: Date;
  }): Promise<void>;
  start(input: StartAutonomousToolCallInput): Promise<Records['toolCalls'] | null>;
  findIdempotent(
    agentId: string,
    taskId: string,
    idempotencyKey: string,
  ): Promise<Records['toolCalls'] | null>;
  cached(input: CachedToolCallInput): Promise<Records['toolCalls']>;
  parentIsMission(agentId: string, parentTaskId: string): Promise<boolean>;
  conversationGoalId(agentId: string, conversationId: string): Promise<string | null>;
  goalWorkEvidence(
    agentId: string,
    taskId: string,
  ): Promise<Array<{ toolName: string; status: string; result: unknown }>>;
  ownerMessageHistory(agentId: string, conversationId: string, before: Date): Promise<string[]>;
  searchResults(taskId: string): Promise<unknown[]>;
}
