import type { Trust } from '@assistant/core';
import type { Db } from '@assistant/db';
import type { z } from 'zod';

export type RiskTier = 'autonomous' | 'approval' | 'forbidden';

export interface ToolContext {
  taskId: string;
  agentId: string;
  conversationId?: string;
  trust: Trust;
  db: Db;
  now: () => Date;
  signal: AbortSignal;
  log: (type: string, payload: unknown) => Promise<void>;
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
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<Out>;
}

/** Tools that can reach outside the assistant's own accounts or mutate memory. */
export interface ToolFlags {
  /** Stripped from the registry for tasks triggered by untrusted content. */
  outwardFacing?: boolean;
  /** Stripped for untrusted-trigger tasks (prevents memory-persistence attacks). */
  writesMemory?: boolean;
  /** Never eligible for a blanket "always allow" policy. */
  blanketAllowIneligible?: boolean;
}

export type RegisteredTool = { tool: AssistantTool; flags: ToolFlags };
