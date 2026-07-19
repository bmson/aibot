import { createHash } from 'node:crypto';
import {
  getRate,
  isBrowserJobPending,
  reconcileReservation,
  releaseReservation,
  reserveCost,
} from '@assistant/core';
import type { Db, TaskRow } from '@assistant/db';
import { approvals, conversations, rateLimits, tasks, toolCache, toolCalls } from '@assistant/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import { isAmbiguousGoogleMutationError } from './google/client.js';
import { matchPolicies } from './policies.js';
import type { ToolRegistry } from './registry.js';
import { isAmbiguousTwilioDeliveryError } from './twilio/client.js';
import type { RegisteredTool, RiskTier, ToolContext } from './types.js';

export interface DispatchInput {
  task: TaskRow;
  step: number;
  /** AI SDK tool-call id, persisted so async tools can rebuild the transcript after a crash. */
  modelToolCallId?: string;
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
  | { kind: 'rejected'; reason: string }
  /** Pre-flight reservation failed — the executor parks the task as waiting_budget. */
  | { kind: 'budget_blocked'; reason: string; resumeAt: Date };

const APPROVAL_TTL_HOURS = 24;

type ToolReservation =
  | {
      ok: true;
      reservationId: string;
      estimatedUsd: number;
      quantity: number;
      unit: string;
      unitPriceUsd: number;
      description: string;
    }
  | { ok: false; reason: string; resumeAt: Date };

function cacheKey(toolName: string, args: Record<string, unknown>): string {
  return createHash('sha256')
    .update(`${toolName}:${JSON.stringify(args)}`)
    .digest('hex');
}

/**
 * Monotonic human code across all historical approvals. Call only while
 * holding the approval-code advisory lock so a delayed SMS can never match a
 * later, unrelated approval after its original code was resolved.
 */
async function nextShortCode(db: Db): Promise<string> {
  const [row] = await db
    .select({
      next: sql<number>`coalesce(max(case when ${approvals.shortCode} ~ '^A[0-9]+$' then substring(${approvals.shortCode} from 2)::bigint end), 0) + 1`,
    })
    .from(approvals);
  return `A${Number(row?.next ?? 1)}`;
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
  toolDefs(
    trust: ToolContext['trust'],
    tainted = false,
    scope: { isMissionSession: boolean } = { isMissionSession: false },
  ) {
    return (
      this.registry
        .toolsForTask(trust, tainted)
        // mission.update writes the parent mission. A normal chat task has no
        // parent, so exposing it lets the model manufacture a progress update
        // that can only fail after it has already narrated the work.
        .filter((tool) => tool.name !== 'mission.update' || scope.isMissionSession)
        // Deterministic internal tools are never model capabilities.
        .filter((tool) => !this.registry.get(tool.name)?.flags.internalEventKind)
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }))
    );
  }

  /** Used by the workflow to durably propagate tool-result provenance. */
  resultIsUntrusted(toolName: string): boolean {
    return this.registry.resultIsUntrusted(toolName);
  }

  /**
   * Execute a tool call the owner approved (possibly with edited args in the
   * approval's resolution_payload). Idempotent: if a crash-retry finds the
   * call already succeeded, the recorded result is returned.
   */
  async executeApproved(
    toolCallId: string,
    ctx: ToolContext,
  ): Promise<
    | { kind: 'executed'; result: unknown }
    | { kind: 'failed'; error: string }
    | { kind: 'budget_blocked'; reason: string; resumeAt: Date }
  > {
    const [call] = await this.db.select().from(toolCalls).where(eq(toolCalls.id, toolCallId));
    if (!call) return { kind: 'failed', error: 'tool call not found' };
    if (isBrowserJobPending(call.result)) return { kind: 'executed', result: call.result };
    if (call.status === 'succeeded') return { kind: 'executed', result: call.result };
    if (call.status !== 'approved') {
      return { kind: 'failed', error: `tool call is ${call.status}, not approved` };
    }

    const registered = this.registry.get(call.toolName);
    if (!registered) {
      return { kind: 'failed', error: `tool ${call.toolName} no longer registered` };
    }

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
      return { kind: 'failed', error: 'approved args failed validation' };
    }

    // Approved calls reserve too — approval grants permission, not budget.
    const reserved = await this.reserveForTool(
      registered,
      parsed.data as Record<string, unknown>,
      call.taskId,
    );
    if (reserved && !reserved.ok) {
      return {
        kind: 'budget_blocked',
        reason: reserved.reason,
        resumeAt: reserved.resumeAt,
      };
    }
    const decision = {
      ...((call.decision ?? {}) as Record<string, unknown>),
      ...(reserved?.ok ? { reservationId: reserved.reservationId } : {}),
    };

    const [claimed] = await this.db
      .update(toolCalls)
      .set({ status: 'executing', args: parsed.data, decision, startedAt: sql`now()` })
      .where(and(eq(toolCalls.id, toolCallId), eq(toolCalls.status, 'approved')))
      .returning({ id: toolCalls.id });
    if (!claimed) {
      if (reserved?.ok) await releaseReservation(this.db, reserved.reservationId).catch(() => {});
      const [current] = await this.db.select().from(toolCalls).where(eq(toolCalls.id, toolCallId));
      return current?.status === 'succeeded'
        ? { kind: 'executed', result: current.result }
        : { kind: 'failed', error: `tool call is ${current?.status ?? 'missing'}, not approved` };
    }

    try {
      const result = await registered.tool.execute(
        parsed.data,
        this.executionContext(
          ctx,
          toolCallId,
          call.toolName,
          ((call.decision ?? {}) as { modelToolCallId?: string }).modelToolCallId,
        ),
      );
      await this.db
        .update(toolCalls)
        .set({
          status: 'succeeded',
          ...(isBrowserJobPending(result) ? {} : { result: result ?? null }),
          finishedAt: sql`now()`,
        })
        .where(eq(toolCalls.id, toolCallId));
      if (reserved?.ok && !isBrowserJobPending(result)) {
        await reconcileReservation(this.db, reserved.reservationId, {
          usd: reserved.estimatedUsd,
          quantity: reserved.quantity,
          unit: reserved.unit,
          unitPriceUsd: reserved.unitPriceUsd,
          toolCallId,
          description: reserved.description,
        }).catch((error) => console.error('approved tool cost reconciliation failed', error));
      }
      return { kind: 'executed', result };
    } catch (err) {
      if (isAmbiguousTwilioDeliveryError(err) || isAmbiguousGoogleMutationError(err)) {
        const result = {
          deliveryStatus: 'unknown',
          retrySuppressed: true,
          note: 'The provider may have accepted this mutation; do not retry automatically.',
        };
        if (reserved?.ok) {
          await reconcileReservation(this.db, reserved.reservationId, {
            usd: reserved.estimatedUsd,
            quantity: reserved.quantity,
            unit: reserved.unit,
            unitPriceUsd: reserved.unitPriceUsd,
            toolCallId,
            description: `${reserved.description} (delivery outcome unknown)`,
          }).catch((error) =>
            console.error('ambiguous approved tool cost reconciliation failed', error),
          );
        }
        await this.db
          .update(toolCalls)
          .set({ status: 'succeeded', result, finishedAt: sql`now()` })
          .where(eq(toolCalls.id, toolCallId));
        return { kind: 'executed', result };
      }
      if (reserved?.ok) await releaseReservation(this.db, reserved.reservationId).catch(() => {});
      await this.db
        .update(toolCalls)
        .set({ status: 'failed', error: String(err).slice(0, 2000), finishedAt: sql`now()` })
        .where(eq(toolCalls.id, toolCallId));
      return { kind: 'failed', error: String(err).slice(0, 500) };
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
    if (registered.flags.internalEventKind) {
      const trigger = input.task.trigger as
        | { source?: unknown; payload?: Record<string, unknown> }
        | undefined;
      if (
        input.ctx.trust !== 'assistant' ||
        trigger?.source !== 'internal' ||
        trigger.payload?.kind !== registered.flags.internalEventKind ||
        (registered.flags.internalEventArgument !== undefined &&
          input.args[registered.flags.internalEventArgument] !==
            trigger.payload?.[registered.flags.internalEventArgument])
      ) {
        return {
          kind: 'rejected',
          reason: `tool ${input.toolName} is restricted to internal ${registered.flags.internalEventKind} events`,
        };
      }
    }
    // Hiding a tool from the model is not an enforcement boundary: models can
    // still emit a guessed tool name. Mission progress may only be written by
    // the bounded child session created from an actual mission.
    if (input.toolName === 'mission.update') {
      if (!input.task.parentTaskId) {
        return {
          kind: 'rejected',
          reason: 'mission.update is available only inside a mission work session',
        };
      }
      const [parent] = await this.db
        .select({ type: tasks.type })
        .from(tasks)
        .where(eq(tasks.id, input.task.parentTaskId));
      if (parent?.type !== 'mission') {
        return {
          kind: 'rejected',
          reason: 'mission.update requires a mission as its parent task',
        };
      }
    }
    // goals.update_progress writes an owner-owned goal row and is intentionally
    // kept available under taint (see builtin/index.ts) so a research-then-report
    // goal loop can record progress without an approval on every step. Because it
    // slips the taint-approval gate, bind the write to the goal this task is
    // actually working: it may only update the task's own goal (scheduled goal
    // automation / goal work task) or the goal its work chat belongs to. Untrusted
    // content that entered the session therefore cannot redirect the write to a
    // different goal or drive one from a task that owns no goal at all.
    if (input.toolName === 'goals.update_progress') {
      const argGoalId =
        typeof input.args.goalId === 'string' ? (input.args.goalId as string) : null;
      let boundGoalId = input.task.goalId ?? null;
      if (!boundGoalId && input.task.conversationId) {
        const [conversation] = await this.db
          .select({ metadata: conversations.metadata })
          .from(conversations)
          .where(eq(conversations.id, input.task.conversationId));
        const metaGoalId = (conversation?.metadata as { goalId?: unknown } | null)?.goalId;
        if (typeof metaGoalId === 'string') boundGoalId = metaGoalId;
      }
      if (!argGoalId || !boundGoalId || argGoalId !== boundGoalId) {
        return {
          kind: 'rejected',
          reason:
            'goals.update_progress may only update the goal this task or its work chat is bound to',
        };
      }
    }
    const { tool } = registered;

    // Taint: reject tools that explicitly cannot consume externally-derived
    // arguments. The workflow also propagates taint from marked tool results.
    if (
      !tool.acceptsUntrustedInput &&
      (input.ctx.trust === 'unknown' || input.ctx.trust === 'known' || input.ctx.tainted)
    ) {
      return {
        kind: 'rejected',
        reason: `tool ${input.toolName} does not accept externally sourced input`,
      };
    }

    const parsed = tool.inputSchema.safeParse(input.args);
    if (!parsed.success) {
      return { kind: 'rejected', reason: `invalid args: ${parsed.error.message}` };
    }
    let args = parsed.data as Record<string, unknown>;

    // Prepare hook (e.g. voice rewrite) — runs BEFORE the approval card is
    // built so what the owner approves is exactly what executes. It is
    // best-effort: today's only hook is the voice rewrite, which is explicitly
    // documented to fail safe to the original draft. A rewrite/embed error (or
    // its budget reservation) must therefore never propagate — that would park
    // or dead-letter the owner's outbound message itself instead of sending it.
    if (tool.prepare) {
      try {
        args = (await tool.prepare(args, input.ctx)) as Record<string, unknown>;
      } catch (err) {
        console.error(
          `tool ${input.toolName} prepare hook failed; dispatching with un-prepared args`,
          err,
        );
      }
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
    // Once attacker-controlled content enters a privileged owner/assistant
    // workflow, private reads/writes and network egress need exact-argument
    // owner approval. This prevents a fetched page or email from chaining a
    // private read into an autonomous exfiltration request. Policy allow rules
    // deliberately cannot override this provenance boundary.
    const privilegedTaint =
      input.ctx.tainted && (input.ctx.trust === 'owner' || input.ctx.trust === 'assistant');
    const taintNeedsApproval =
      privilegedTaint &&
      (registered.flags.confidentialRead === true ||
        registered.flags.writesMemory === true ||
        registered.flags.writesWorkspace === true ||
        registered.flags.privateWrite === true ||
        registered.flags.networkEgress === true);
    const tier: RiskTier = taintNeedsApproval
      ? 'approval'
      : policyMatch?.effect === 'allow'
        ? 'autonomous'
        : baseTier;

    const decision = {
      riskTier: tier,
      reason: taintNeedsApproval
        ? 'owner approval required because untrusted content entered this workflow'
        : policyMatch?.effect === 'allow'
          ? `allowed by policy ${policyMatch.policy.templateKey}`
          : `tool default (${baseTier})`,
      policyId: policyMatch?.policy.id,
      policyVersion: policyMatch?.policy.version,
      plannerVersion: input.provenance.plannerVersion,
      promptVersion: input.provenance.promptVersion,
      model: input.provenance.model,
      modelToolCallId: input.modelToolCallId,
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

  /** Reserve a tool's declared cost estimate. null = tool has no estimate (nothing to reserve). */
  private async reserveForTool(
    registered: RegisteredTool,
    args: Record<string, unknown>,
    taskId: string,
  ): Promise<ToolReservation | null> {
    const estimate = registered.tool.estimateCost?.(args);
    if (!estimate) return null;
    const rate = await getRate(this.db, estimate.rateKey);
    const estimatedUsd = estimate.quantity * rate.unitPriceUsd;
    if (estimatedUsd <= 0) return null;
    const reservation = await reserveCost(this.db, {
      source: estimate.source,
      estimatedUsd,
      taskId,
      description: estimate.description ?? registered.tool.name,
    });
    return reservation.ok
      ? {
          ...reservation,
          estimatedUsd,
          quantity: estimate.quantity,
          unit: rate.unit,
          unitPriceUsd: rate.unitPriceUsd,
          description: estimate.description ?? registered.tool.name,
        }
      : reservation;
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

    const parked = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('assistant:approval-codes'))`);
      const shortCode = await nextShortCode(tx as unknown as Db);
      const [toolCall] = await tx
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
      const [approval] = await tx
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
      const [linked] = await tx
        .update(toolCalls)
        .set({ approvalId: approval.id })
        .where(eq(toolCalls.id, toolCall.id))
        .returning({ id: toolCalls.id });
      if (!linked) throw new Error('failed to link approval');
      return { toolCall: { ...toolCall, approvalId: approval.id }, approval };
    });

    return {
      kind: 'awaiting_approval',
      toolCallId: parked.toolCall.id,
      approvalId: parked.approval.id,
      shortCode: parked.approval.shortCode,
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
      if (prior) {
        return {
          kind: 'rejected',
          reason: `identical call is already recorded as ${prior.status}; refusing an ambiguous side-effect retry`,
        };
      }
    }

    // Reserve only after cache/idempotency shortcuts. A free replay must not
    // strand a budget hold until the stale-reservation sweeper runs.
    const reserved = await this.reserveForTool(registered, args, input.task.id);
    if (reserved && !reserved.ok) {
      return { kind: 'budget_blocked', reason: reserved.reason, resumeAt: reserved.resumeAt };
    }
    if (reserved?.ok) decision.reservationId = reserved.reservationId;

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
      if (reserved?.ok) await releaseReservation(this.db, reserved.reservationId).catch(() => {});
      return { kind: 'rejected', reason: 'identical call already in flight' };
    }

    try {
      const result = await registered.tool.execute(
        args,
        this.executionContext(input.ctx, row.id, input.toolName, input.modelToolCallId),
      );
      await this.db
        .update(toolCalls)
        .set({
          status: 'succeeded',
          ...(isBrowserJobPending(result) ? {} : { result: result ?? null }),
          finishedAt: sql`now()`,
        })
        .where(eq(toolCalls.id, row.id));

      if (reserved?.ok && !isBrowserJobPending(result)) {
        await reconcileReservation(this.db, reserved.reservationId, {
          usd: reserved.estimatedUsd,
          quantity: reserved.quantity,
          unit: reserved.unit,
          unitPriceUsd: reserved.unitPriceUsd,
          toolCallId: row.id,
          description: reserved.description,
        }).catch((error) => console.error('tool cost reconciliation failed', error));
      }

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
      if (isAmbiguousTwilioDeliveryError(err) || isAmbiguousGoogleMutationError(err)) {
        const result = {
          deliveryStatus: 'unknown',
          retrySuppressed: true,
          note: 'The provider may have accepted this mutation; do not retry automatically.',
        };
        if (reserved?.ok) {
          await reconcileReservation(this.db, reserved.reservationId, {
            usd: reserved.estimatedUsd,
            quantity: reserved.quantity,
            unit: reserved.unit,
            unitPriceUsd: reserved.unitPriceUsd,
            toolCallId: row.id,
            description: `${reserved.description} (delivery outcome unknown)`,
          }).catch((error) => console.error('ambiguous tool cost reconciliation failed', error));
        }
        await this.db
          .update(toolCalls)
          .set({ status: 'succeeded', result, finishedAt: sql`now()` })
          .where(eq(toolCalls.id, row.id));
        return { kind: 'executed', toolCallId: row.id, result, cached: false };
      }

      // A definitive rejection means the reserved work never happened.
      const reservationId = (decision as Record<string, unknown>).reservationId;
      if (typeof reservationId === 'string') {
        await releaseReservation(this.db, reservationId).catch(() => {});
      }
      await this.db
        .update(toolCalls)
        .set({ status: 'failed', error: String(err).slice(0, 2000), finishedAt: sql`now()` })
        .where(eq(toolCalls.id, row.id));
      return { kind: 'rejected', reason: `execution failed: ${String(err).slice(0, 500)}` };
    }
  }

  private executionContext(
    ctx: ToolContext,
    dbToolCallId: string,
    toolName: string,
    modelToolCallId?: string,
  ): ToolContext {
    return {
      ...ctx,
      execution: {
        dbToolCallId,
        modelToolCallId: modelToolCallId ?? '',
        toolName,
      },
    };
  }
}
