import { createHash } from 'node:crypto';
import type { Db, TaskRow } from '@assistant/db';
import { approvals, rateLimits, toolCache, toolCalls } from '@assistant/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import { matchPolicies } from './policies.js';
import type { ToolRegistry } from './registry.js';
import type { RegisteredTool, RiskTier, ToolContext } from './types.js';

export interface DispatchInput {
  task: TaskRow;
  step: number;
  toolName: string;
  args: Record<string, unknown>;
  ctx: ToolContext;
  /** Provenance for tool_calls.decision. */
  provenance: { plannerVersion: number; promptVersion: number; model: string };
}

export type DispatchOutcome =
  | { kind: 'executed'; toolCallId: string; result: unknown; cached: boolean }
  | {
      kind: 'awaiting_approval';
      toolCallId: string;
      approvalId: string;
      shortCode: string;
      summary: string;
    }
  | { kind: 'rejected'; reason: string };

const APPROVAL_TTL_HOURS = 24;

function cacheKey(toolName: string, args: Record<string, unknown>): string {
  return createHash('sha256')
    .update(`${toolName}:${JSON.stringify(args)}`)
    .digest('hex');
}

/** Lowest unused short code among pending approvals: A1, A2, ... */
async function nextShortCode(db: Db): Promise<string> {
  const pending = await db
    .select({ shortCode: approvals.shortCode })
    .from(approvals)
    .where(eq(approvals.status, 'pending'));
  const used = new Set(pending.map((p) => p.shortCode));
  let n = 1;
  while (used.has(`A${n}`)) n += 1;
  return `A${n}`;
}

async function underRateLimit(db: Db, scope: string): Promise<boolean> {
  const [limit] = await db.select().from(rateLimits).where(eq(rateLimits.scope, scope));
  if (!limit) return true;

  const countSince = async (interval: string) => {
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(toolCalls)
      .where(
        and(
          eq(toolCalls.toolName, scope.replace(/^tool:/, '')),
          gte(toolCalls.createdAt, sql`now() - ${interval}::interval`),
          eq(toolCalls.status, 'succeeded'),
        ),
      );
    return Number(row?.n ?? 0);
  };

  if (limit.maxPerHour !== null && (await countSince('1 hour')) >= limit.maxPerHour) return false;
  if (limit.maxPerDay !== null && (await countSince('1 day')) >= limit.maxPerDay) return false;
  return true;
}

/**
 * The risk gate — the enforcement boundary between model output and the world.
 * Evaluation order is part of the security contract:
 *   1. tool exists & is in this task's trust-scoped registry (forbidden-by-construction)
 *   2. taint check (acceptsUntrustedInput)
 *   3. approval_policies match (deny, then allow)
 *   4. dynamic risk function → default tier
 *   5. rate limits, cache, idempotent execution
 */
export class ToolDispatcher {
  constructor(
    private db: Db,
    private registry: ToolRegistry,
  ) {}

  /** Model-facing tool definitions for a task's trust level (no execute functions). */
  toolDefs(trust: ToolContext['trust']) {
    return this.registry.toolsForTask(trust).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /**
   * Execute a tool call the owner approved (possibly with edited args in the
   * approval's resolution_payload). Idempotent: if a crash-retry finds the
   * call already succeeded, the recorded result is returned.
   */
  async executeApproved(
    toolCallId: string,
    ctx: ToolContext,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    const [call] = await this.db.select().from(toolCalls).where(eq(toolCalls.id, toolCallId));
    if (!call) return { ok: false, error: 'tool call not found' };
    if (call.status === 'succeeded') return { ok: true, result: call.result };
    if (call.status !== 'approved') {
      return { ok: false, error: `tool call is ${call.status}, not approved` };
    }

    const registered = this.registry.get(call.toolName);
    if (!registered) return { ok: false, error: `tool ${call.toolName} no longer registered` };

    let args = (call.args ?? {}) as Record<string, unknown>;
    if (call.approvalId) {
      const [approval] = await this.db
        .select()
        .from(approvals)
        .where(eq(approvals.id, call.approvalId));
      if (approval?.resolutionPayload) {
        args = approval.resolutionPayload as Record<string, unknown>;
      }
    }

    const parsed = registered.tool.inputSchema.safeParse(args);
    if (!parsed.success) {
      await this.db
        .update(toolCalls)
        .set({ status: 'failed', error: `invalid approved args: ${parsed.error.message}` })
        .where(eq(toolCalls.id, toolCallId));
      return { ok: false, error: 'approved args failed validation' };
    }

    await this.db
      .update(toolCalls)
      .set({ status: 'executing', args: parsed.data, startedAt: sql`now()` })
      .where(eq(toolCalls.id, toolCallId));

    try {
      const result = await registered.tool.execute(parsed.data, ctx);
      await this.db
        .update(toolCalls)
        .set({ status: 'succeeded', result: result ?? null, finishedAt: sql`now()` })
        .where(eq(toolCalls.id, toolCallId));
      return { ok: true, result };
    } catch (err) {
      await this.db
        .update(toolCalls)
        .set({ status: 'failed', error: String(err).slice(0, 2000), finishedAt: sql`now()` })
        .where(eq(toolCalls.id, toolCallId));
      return { ok: false, error: String(err).slice(0, 500) };
    }
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutcome> {
    const registered = this.registry.get(input.toolName);
    const allowedForTrust = this.registry
      .toolsForTask(input.ctx.trust)
      .some((t) => t.name === input.toolName);
    if (!registered || !allowedForTrust) {
      return {
        kind: 'rejected',
        reason: `tool ${input.toolName} is not available for this task`,
      };
    }
    const { tool } = registered;

    // Taint: tools that must never see untrusted-derived args. Phase 2
    // approximation: task-level trust; per-arg provenance is a later refinement.
    if (!tool.acceptsUntrustedInput && input.ctx.trust === 'unknown') {
      return {
        kind: 'rejected',
        reason: `tool ${input.toolName} does not accept untrusted input`,
      };
    }

    const parsed = tool.inputSchema.safeParse(input.args);
    if (!parsed.success) {
      return { kind: 'rejected', reason: `invalid args: ${parsed.error.message}` };
    }
    let args = parsed.data as Record<string, unknown>;

    // Prepare hook (e.g. voice rewrite) — runs BEFORE the approval card is
    // built so what the owner approves is exactly what executes.
    if (tool.prepare) {
      args = (await tool.prepare(args, input.ctx)) as Record<string, unknown>;
    }

    // Policy match (templates only; unknown templates fail closed)
    const policyMatch = await matchPolicies(this.db, {
      agentId: input.task.agentId,
      toolName: input.toolName,
      args,
      ctx: input.ctx,
    });
    if (policyMatch?.effect === 'deny') {
      return {
        kind: 'rejected',
        reason: `denied by policy ${policyMatch.policy.templateKey}`,
      };
    }

    // Tier: policy allow overrides an 'approval' tier; dynamic fn otherwise.
    const baseTier: RiskTier =
      typeof tool.risk === 'function' ? tool.risk(args, input.ctx) : tool.risk;
    if (baseTier === 'forbidden') {
      return { kind: 'rejected', reason: `tool ${input.toolName} is forbidden` };
    }
    const tier: RiskTier = policyMatch?.effect === 'allow' ? 'autonomous' : baseTier;

    const decision = {
      riskTier: tier,
      reason:
        policyMatch?.effect === 'allow'
          ? `allowed by policy ${policyMatch.policy.templateKey}`
          : `tool default (${baseTier})`,
      policyId: policyMatch?.policy.id,
      policyVersion: policyMatch?.policy.version,
      plannerVersion: input.provenance.plannerVersion,
      promptVersion: input.provenance.promptVersion,
      model: input.provenance.model,
    };

    if (tier === 'approval') {
      return this.parkForApproval({ input, args, decision, registered });
    }

    // Rate limit (autonomous executions only — approvals are human-gated anyway)
    if (!(await underRateLimit(this.db, `tool:${input.toolName}`))) {
      return { kind: 'rejected', reason: `rate limit exceeded for ${input.toolName}` };
    }

    // Cache
    const key = cacheKey(input.toolName, args);
    if (tool.cacheTtlSeconds) {
      const [hit] = await this.db
        .select()
        .from(toolCache)
        .where(and(eq(toolCache.cacheKey, key), gte(toolCache.expiresAt, sql`now()`)));
      if (hit) {
        const [row] = await this.db
          .insert(toolCalls)
          .values({
            taskId: input.task.id,
            step: input.step,
            toolName: input.toolName,
            args,
            risk: tier,
            status: 'succeeded',
            result: hit.result,
            decision: { ...decision, cached: true },
            startedAt: sql`now()`,
            finishedAt: sql`now()`,
          })
          .returning();
        return {
          kind: 'executed',
          toolCallId: (row as NonNullable<typeof row>).id,
          result: hit.result,
          cached: true,
        };
      }
    }

    return this.execute({ input, args, decision, registered });
  }

  private async parkForApproval(opts: {
    input: DispatchInput;
    args: Record<string, unknown>;
    decision: Record<string, unknown>;
    registered: RegisteredTool;
  }): Promise<DispatchOutcome> {
    const { input, args, decision, registered } = opts;
    const summary =
      registered.tool.approvalSummary?.(args) ?? `${input.toolName}(${JSON.stringify(args)})`;

    const [toolCall] = await this.db
      .insert(toolCalls)
      .values({
        taskId: input.task.id,
        step: input.step,
        toolName: input.toolName,
        args,
        risk: 'approval',
        status: 'awaiting_approval',
        decision,
      })
      .returning();
    if (!toolCall) throw new Error('failed to insert tool_call');

    const shortCode = await nextShortCode(this.db);
    const [approval] = await this.db
      .insert(approvals)
      .values({
        taskId: input.task.id,
        toolCallId: toolCall.id,
        shortCode,
        summary,
        payload: args,
        expiresAt: sql`now() + interval '${sql.raw(String(APPROVAL_TTL_HOURS))} hours'`,
      })
      .returning();
    if (!approval) throw new Error('failed to insert approval');

    await this.db
      .update(toolCalls)
      .set({ approvalId: approval.id })
      .where(eq(toolCalls.id, toolCall.id));

    return {
      kind: 'awaiting_approval',
      toolCallId: toolCall.id,
      approvalId: approval.id,
      shortCode,
      summary,
    };
  }

  private async execute(opts: {
    input: DispatchInput;
    args: Record<string, unknown>;
    decision: Record<string, unknown>;
    registered: RegisteredTool;
  }): Promise<DispatchOutcome> {
    const { input, args, decision, registered } = opts;
    const idempotencyKey = registered.tool.idempotencyKey?.(args, input.ctx);

    // Crash-retry protection: if this exact side effect already succeeded,
    // return the recorded result instead of executing again.
    if (idempotencyKey) {
      const [prior] = await this.db
        .select()
        .from(toolCalls)
        .where(eq(toolCalls.idempotencyKey, idempotencyKey));
      if (prior?.status === 'succeeded') {
        return { kind: 'executed', toolCallId: prior.id, result: prior.result, cached: false };
      }
      if (prior && prior.status === 'executing') {
        return { kind: 'rejected', reason: 'identical call already executing' };
      }
    }

    const [row] = await this.db
      .insert(toolCalls)
      .values({
        taskId: input.task.id,
        step: input.step,
        toolName: input.toolName,
        args,
        risk: 'autonomous',
        status: 'executing',
        idempotencyKey,
        decision,
        startedAt: sql`now()`,
      })
      .onConflictDoNothing({
        target: toolCalls.idempotencyKey,
        where: sql`${toolCalls.idempotencyKey} IS NOT NULL`,
      })
      .returning();
    if (!row) {
      // lost an idempotency race to a concurrent executor
      return { kind: 'rejected', reason: 'identical call already in flight' };
    }

    try {
      const result = await registered.tool.execute(args, input.ctx);
      await this.db
        .update(toolCalls)
        .set({ status: 'succeeded', result: result ?? null, finishedAt: sql`now()` })
        .where(eq(toolCalls.id, row.id));

      if (registered.tool.cacheTtlSeconds) {
        await this.db
          .insert(toolCache)
          .values({
            cacheKey: cacheKey(input.toolName, args),
            toolName: input.toolName,
            result: (result ?? null) as Record<string, unknown> | null,
            expiresAt: sql`now() + interval '${sql.raw(String(registered.tool.cacheTtlSeconds))} seconds'`,
          })
          .onConflictDoUpdate({
            target: toolCache.cacheKey,
            set: {
              result: (result ?? null) as Record<string, unknown> | null,
              expiresAt: sql`now() + interval '${sql.raw(String(registered.tool.cacheTtlSeconds))} seconds'`,
            },
          });
      }

      return { kind: 'executed', toolCallId: row.id, result, cached: false };
    } catch (err) {
      await this.db
        .update(toolCalls)
        .set({ status: 'failed', error: String(err).slice(0, 2000), finishedAt: sql`now()` })
        .where(eq(toolCalls.id, row.id));
      return { kind: 'rejected', reason: `execution failed: ${String(err).slice(0, 500)}` };
    }
  }
}
