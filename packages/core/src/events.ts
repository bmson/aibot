import { z } from 'zod';

/** Where the assistant's trust in a piece of content or a trigger comes from. */
export const TrustSchema = z.enum(['owner', 'known', 'unknown', 'assistant']);
export type Trust = z.infer<typeof TrustSchema>;

export const EventSourceSchema = z.enum([
  'chat',
  'sms',
  'email',
  'schedule',
  'approval',
  'mission_wake',
  'internal',
]);
export type EventSource = z.infer<typeof EventSourceSchema>;

/**
 * Every event source (chat POST, Twilio webhook, Gmail push, Scheduler tick,
 * approval resolution, mission wake) normalizes to this envelope before a
 * workflow is enqueued. The runtime does not care where work came from.
 */
export const InboundEventSchema = z.object({
  source: EventSourceSchema,
  /** Idempotency key for event → task creation (Gmail msgId, Twilio SID, ...). */
  externalEventId: z.string().optional(),
  agentId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  trust: TrustSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type InboundEvent = z.infer<typeof InboundEventSchema>;

/** Planner output — the planner decides, it never executes. */
export const PlanSchema = z.object({
  action: z.enum(['reply', 'workflow', 'mission', 'schedule', 'clarify']),
  reasoning: z.string().default(''),
  steps: z.array(z.string()).default([]),
  missingInfo: z.array(z.string()).default([]),
  goalId: z.string().uuid().optional(),
  deadline: z.string().optional(),
  budgetSuggestionUsd: z.number().optional(),
});
export type Plan = z.infer<typeof PlanSchema>;

/**
 * Authoritative task checkpoint. contextWindow is the compacted working
 * context — full tool results live once in tool_calls and are referenced here.
 */
/**
 * A parked approval: approvalId is the approvals row; toolCallId is the
 * MODEL's tool-call id (needed to stitch the result back into the transcript);
 * dbToolCallId is the tool_calls row to execute on approval.
 */
export const PendingApprovalSchema = z.object({
  approvalId: z.string(),
  toolCallId: z.string(),
  dbToolCallId: z.string(),
  toolName: z.string(),
});
export type PendingApproval = z.infer<typeof PendingApprovalSchema>;

/**
 * A launched-and-awaited browser job: the task sleeps while the Playwright
 * job runs; the job's one-shot-token callback (or the timeout backstop)
 * wakes it, and the executor stitches the result from the tool_calls row.
 */
export const PendingJobSchema = z.object({
  dbToolCallId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  callbackToken: z.string(),
  timeoutAt: z.string(),
});
export type PendingJob = z.infer<typeof PendingJobSchema>;

/**
 * A final response is checkpointed before channel delivery. If the provider
 * fails (or the process crashes), a retry delivers this exact text instead of
 * asking the model again and potentially producing duplicate/inconsistent
 * replies.
 */
export const PendingFinalSchema = z.object({
  text: z.string(),
  progress: z.string(),
  terminalStatus: z.enum(['done', 'failed']),
  outcome: z.enum(['done', 'clarify', 'failed']),
  /** Persisted before channel send; retries never duplicate an ambiguous accepted delivery. */
  deliveryAttempted: z.boolean().optional(),
});
export type PendingFinal = z.infer<typeof PendingFinalSchema>;

export const TaskStateSchema = z.object({
  phase: z.string().default('start'),
  step: z.number().int().default(0),
  completedToolCallIds: z.array(z.string()).default([]),
  /** One model step can propose several approval-gated calls — all park together. */
  pendingApprovals: z.array(PendingApprovalSchema).default([]),
  /** An in-flight browser job this task is waiting on. */
  pendingJob: PendingJobSchema.nullish(),
  /** Durable final-channel delivery checkpoint. */
  pendingFinal: PendingFinalSchema.nullish(),
  /** External/tool content has entered the model context; privileged calls are constrained. */
  untrustedContext: z.boolean().default(false),
  /** Earlier discussions auto-recall drew on this turn, for the chat UI affordance (Phase 4). */
  recall: z.array(z.object({ date: z.string(), label: z.string() })).nullish(),
  plannerState: z.record(z.string(), z.unknown()).default({}),
  scratchpad: z.string().default(''),
  contextWindow: z.array(z.record(z.string(), z.unknown())).default([]),
});
export type TaskState = z.infer<typeof TaskStateSchema>;
