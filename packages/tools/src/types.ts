import type { StagedJobPending, Trust } from '@assistant/core';
import type { Db, SpendSource } from '@assistant/db';
import type { z } from 'zod';

export type RiskTier = 'autonomous' | 'approval' | 'forbidden';

export interface ToolExecutionIdentity {
  dbToolCallId: string;
  modelToolCallId: string;
  toolName: string;
}

export interface StagedBrowserJob extends ToolExecutionIdentity {
  pending: StagedJobPending;
}

export interface ToolContext {
  taskId: string;
  agentId: string;
  conversationId?: string;
  trust: Trust;
  /** True once externally controlled content has entered this workflow's model context. */
  tainted: boolean;
  /**
   * Email addresses and phone numbers the owner/thread actually provided (from
   * the seed conversation window + trigger payload). The dispatcher treats a
   * recipient outside this set ∪ contacts as unverified and escalates the send
   * to owner approval, so the model cannot silently email a fabricated address.
   */
  knownAddresses?: { emails: string[]; phones: string[] };
  db: Db;
  now: () => Date;
  signal: AbortSignal;
  log: (type: string, payload: unknown) => Promise<void>;
  /** Present only while the dispatcher is executing a persisted tool_calls row. */
  execution?: ToolExecutionIdentity;
  /** Browser launch intent must be checkpointed before the external job request. */
  stageBrowserJob?: (job: StagedBrowserJob) => Promise<void>;
  /** Roll back a staged intent after a definitive pre-launch/provider rejection. */
  clearStagedBrowserJob?: (job: StagedBrowserJob) => Promise<void>;
}

/**
 * The tool contract. `risk` may be a function for dynamic tiers (e.g. a
 * calendar event with no attendees is autonomous; with attendees it needs
 * approval). Tools with `acceptsUntrustedInput: false` are rejected by the
 * dispatcher when their args derive from untrusted-origin content, regardless
 * of the task's trust tier.
 */
export interface AssistantTool<S extends z.ZodType = z.ZodType, Out = unknown> {
  name: string;
  description: string;
  inputSchema: S;
  risk: RiskTier | ((args: z.infer<S>, ctx: ToolContext) => RiskTier);
  acceptsUntrustedInput: boolean;
  /**
   * Optional args transform run after validation, before risk evaluation and
   * approval-card creation (e.g. voice rewrite of outbound text) — so what
   * the owner approves is exactly what executes.
   */
  prepare?: (args: z.infer<S>, ctx: ToolContext) => Promise<z.infer<S>>;
  /** Human-readable action line shown on approval cards. */
  approvalSummary?: (args: z.infer<S>) => string;
  idempotencyKey?: (args: z.infer<S>, ctx: ToolContext) => string;
  cacheTtlSeconds?: number;
  /**
   * Pre-flight cost estimate (Phase 27): declared by tools that start
   * expensive work (job launches, outbound calls). The dispatcher reserves
   * quantity × rate_table[rateKey] against remaining budget BEFORE execute —
   * insufficient budget defers the call (task parks as waiting_budget)
   * instead of launching and overshooting.
   */
  estimateCost?: (args: z.infer<S>) => {
    source: SpendSource;
    rateKey: string;
    quantity: number;
    description?: string;
  } | null;
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<Out>;
}

/** Security capabilities used to remove tools from untrusted task registries. */
export interface ToolFlags {
  /** Hidden from models and callable only by this exact internal event kind. */
  internalEventKind?: string;
  /** Argument whose value must equal the same-named internal event payload field. */
  internalEventArgument?: string;
  /** Stripped from the registry for tasks triggered by untrusted content. */
  outwardFacing?: boolean;
  /** Stripped for untrusted-trigger tasks (prevents memory-persistence attacks). */
  writesMemory?: boolean;
  /** Reads owner-private data such as mail, calendars, memory, goals, or files. */
  confidentialRead?: boolean;
  /** Mutates the owner's private workspace. */
  writesWorkspace?: boolean;
  /** Writes private assistant state outside the workspace (for example Gmail drafts). */
  privateWrite?: boolean;
  /** The result may contain attacker-controlled instructions/content. */
  returnsUntrustedContent?: boolean;
  /** Sends an attacker-observable network request even though it is nominally a read. */
  networkEgress?: boolean;
  /** Never eligible for a blanket "always allow" policy. */
  blanketAllowIneligible?: boolean;
  /**
   * The tool's ONLY sink is the owner's own dashboard/conversation — it cannot
   * reach a third party or the network. Such a tool stays autonomous even under
   * taint: gating a message the owner sends to themselves behind the owner's own
   * approval is pure friction (they would have to approve being told something),
   * and it conveys no capability the model's normal reply text does not already
   * have. Use with extreme care — set it ONLY when the recipient is hardwired to
   * the owner and no argument can redirect it.
   */
  ownerVisibleOnly?: boolean;
}

export type RegisteredTool = { tool: AssistantTool; flags: ToolFlags };
