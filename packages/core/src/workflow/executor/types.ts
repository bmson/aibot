import type { Db, TaskRow } from '@assistant/db';
import type { ZodType } from 'zod';
import type { StagedJobPending } from '../../code-exec.js';
import type { Trust } from '../../events.js';
import type { DocumentProcessorConfig } from '../../memory/document-processor.js';
import type { WorkspaceReader } from '../../memory/import.js';
import type { ModelRouter } from '../../model-router/router.js';

/** Structural port implemented by @assistant/tools' ToolDispatcher — keeps core free of a package cycle. */
export interface DispatcherPort {
  toolDefs(
    trust: Trust,
    scope?: { isMissionSession: boolean },
  ): Array<{ name: string; description: string; inputSchema: ZodType }>;
  resultIsUntrusted(toolName: string): boolean;
  dispatch(input: {
    task: TaskRow;
    step: number;
    modelToolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    ctx: ToolContextLike;
    provenance: { plannerVersion: number; promptVersion: number; model: string };
  }): Promise<
    | { kind: 'executed'; toolCallId: string; result: unknown; cached: boolean }
    | {
        kind: 'awaiting_approval';
        toolCallId: string;
        approvalId: string;
        shortCode: string;
        summary: string;
      }
    | { kind: 'rejected'; reason: string }
    | { kind: 'budget_blocked'; reason: string; resumeAt: Date }
  >;
  executeApproved(
    toolCallId: string,
    ctx: ToolContextLike,
  ): Promise<
    | { kind: 'executed'; result: unknown }
    | { kind: 'failed'; error: string }
    | { kind: 'budget_blocked'; reason: string; resumeAt: Date }
  >;
}

export interface ToolContextLike {
  taskId: string;
  agentId: string;
  conversationId?: string;
  trust: Trust;
  tainted: boolean;
  /** Owner/thread-provided recipients used by the dispatcher's provenance guard. */
  knownAddresses?: { emails: string[]; phones: string[] };
  db: Db;
  now: () => Date;
  signal: AbortSignal;
  log: (type: string, payload: unknown) => Promise<void>;
  execution?: { dbToolCallId: string; modelToolCallId: string; toolName: string };
  stageBrowserJob?: (job: {
    dbToolCallId: string;
    modelToolCallId: string;
    toolName: string;
    pending: StagedJobPending;
  }) => Promise<void>;
  clearStagedBrowserJob?: (job: {
    dbToolCallId: string;
    modelToolCallId: string;
    toolName: string;
    pending: StagedJobPending;
  }) => Promise<void>;
}

export interface ExecutorDeps {
  db: Db;
  router: ModelRouter;
  dispatcher: DispatcherPort;
  /** Workspace file store — required only for code jobs that read archives (imports). */
  workspace?: WorkspaceReader;
  /** Document-processor launcher + callback URL (Phase 14). Absent = feature inert. */
  documentProcessor?: DocumentProcessorConfig;
  /** Channel delivery for a task's final text (e.g. SMS reply). Errors are retried by the workflow. */
  deliverFinal?: (task: TaskRow, text: string) => Promise<void>;
  /**
   * Owner notification when approvals park a task (e.g. SMS "Reply YES A7").
   *
   * Receives the task so the deliverer can also answer on the channel the
   * request arrived on. That matters for email: parking otherwise leaves the
   * thread the owner is watching completely silent, because
   * postConversationNotice only writes a dashboard row.
   */
  notifyApproval?: (
    task: TaskRow,
    approvals: Array<{ taskId: string; shortCode: string; summary: string; toolName?: string }>,
  ) => Promise<void>;
  /**
   * Out-of-band owner ping for async events the owner would otherwise only see
   * by opening the dashboard: a task that permanently failed (dead-letter), a
   * task stalled on its own budget cap, or a mission that needs a decision.
   * Delivered to the owner's channel (e.g. SMS) in addition to the dashboard
   * conversation notice. Best-effort — callers swallow its errors.
   */
  notifyOwner?: (input: {
    taskId: string;
    conversationId: string | null;
    text: string;
  }) => Promise<void>;
}

export type ExecuteResult = {
  outcome:
    | 'done'
    | 'parked'
    | 'sleeping'
    | 'failed'
    | 'dead_letter'
    | 'not_claimable'
    | 'needs_attention'
    | 'clarify';
  detail?: string;
};

export const LOST_LEASE: ExecuteResult = {
  outcome: 'not_claimable',
  detail: 'task lease was cancelled, expired, or reclaimed',
};
