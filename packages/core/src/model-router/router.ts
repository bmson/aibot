import { type Db, modelCalls, modelRoles, models, tasks } from '@assistant/db';
import { createOpenRouter, type OpenRouterProvider } from '@openrouter/ai-sdk-provider';
import {
  embedMany,
  generateObject,
  generateText,
  type LanguageModel,
  type ModelMessage,
  streamText,
  type ToolSet,
} from 'ai';
import { and, eq, sql } from 'drizzle-orm';
import type { ZodType } from 'zod';
import { costTotals, getRate, recordCostEvent } from '../cost.js';
import { withSpan } from '../otel.js';
import { type BudgetDecision, evaluateBudget } from './budget.js';

export type ModelRole = 'plan' | 'classify' | 'extract' | 'draft' | 'reason' | 'rewrite' | 'embed';

export interface RouteOptions {
  taskId?: string;
  /** Explicit model pick (chat switcher). Must exist + be enabled; still budget-guarded. */
  modelOverride?: string;
  /** Owner chat/SMS replies: hard caps degrade instead of blocking (carve-out). */
  critical?: boolean;
}

export type Route =
  | {
      ok: true;
      model: LanguageModel;
      modelId: string;
      degraded: boolean;
      decision: BudgetDecision;
      params: Record<string, unknown>;
    }
  | { ok: false; decision: Extract<BudgetDecision, { mode: 'park' | 'block' }> };

export interface CallOptions {
  taskId?: string;
  modelOverride?: string;
  /** Owner chat/SMS replies: hard caps degrade instead of blocking (carve-out). */
  critical?: boolean;
  system?: string;
  messages?: ModelMessage[];
  prompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}

export type GenerateOutcome =
  | { ok: false; decision: Extract<BudgetDecision, { mode: 'park' | 'block' }> }
  | { ok: true; modelId: string; degraded: boolean; text: string; finishReason?: string };

/** A proposed (unexecuted) tool call — the executor feeds these to the risk gate. */
export interface ProposedToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export type StepCallOutcome =
  | { ok: false; decision: Extract<BudgetDecision, { mode: 'park' | 'block' }> }
  | {
      ok: true;
      modelId: string;
      degraded: boolean;
      text: string;
      toolCalls: ProposedToolCall[];
      finishReason?: string;
    };

export type ObjectOutcome<T> =
  | { ok: false; decision: Extract<BudgetDecision, { mode: 'park' | 'block' }> }
  | { ok: true; modelId: string; degraded: boolean; object: T };

export type StreamOutcome =
  | { ok: false; decision: Extract<BudgetDecision, { mode: 'park' | 'block' }> }
  | {
      ok: true;
      modelId: string;
      degraded: boolean;
      text: PromiseLike<string>;
      toUIMessageStreamResponse: (options?: Record<string, unknown>) => Response;
    };

/** Loose supertype of the AI SDK finish events — only what metering reads. */
interface FinishEventLike {
  usage?: { inputTokens?: number; outputTokens?: number };
  providerMetadata?: Record<string, unknown>;
  response?: { id?: string };
  finishReason?: string;
}

interface MeterInput {
  taskId?: string;
  role: string;
  modelId: string;
  latencyMs: number;
  event: FinishEventLike;
}

function extractCost(providerMetadata: Record<string, unknown> | undefined): number {
  const openrouter = providerMetadata?.openrouter as { usage?: { cost?: number } } | undefined;
  return openrouter?.usage?.cost ?? 0;
}

function promptArgs(opts: CallOptions): { messages: ModelMessage[] } | { prompt: string } {
  if (opts.messages) return { messages: opts.messages };
  if (opts.prompt !== undefined) return { prompt: opts.prompt };
  throw new Error('model call needs messages or prompt');
}

export class ModelRouter {
  private provider: OpenRouterProvider;

  constructor(
    private db: Db,
    apiKey: string,
  ) {
    this.provider = createOpenRouter({ apiKey });
  }

  /**
   * Budget snapshot for the guard. Daily/monthly spend comes from the unified
   * cost ledger (Phase 27) — model calls, embeddings, SMS, job-seconds — plus
   * estimated USD held by unreconciled reservations, so a launched job's
   * budget can't be double-spent before it reports actuals.
   */
  private async budgetSnapshot(taskId?: string) {
    const totals = await costTotals(this.db);

    let taskLimitUsd: number | undefined;
    let taskSpentUsd: number | undefined;
    if (taskId) {
      const [task] = await this.db
        .select({ limit: tasks.budgetUsdLimit, spent: tasks.spentUsd })
        .from(tasks)
        .where(eq(tasks.id, taskId));
      if (task) {
        taskLimitUsd = Number(task.limit);
        taskSpentUsd = Number(task.spent);
      }
    }

    return {
      taskLimitUsd,
      taskSpentUsd,
      dailyLimitUsd: totals.dailyLimitUsd,
      dailySpentUsd: totals.dailySpentUsd + totals.heldUsd,
      monthlyLimitUsd: totals.monthlyLimitUsd,
      monthlySpentUsd: totals.monthlySpentUsd + totals.heldUsd,
      softPct: totals.softPct,
    };
  }

  /** Resolve role → model through the capability matrix and the budget guard. */
  async route(role: ModelRole, opts: RouteOptions = {}): Promise<Route> {
    const decision = evaluateBudget(await this.budgetSnapshot(opts.taskId), {
      critical: opts.critical,
    });
    if (decision.mode === 'park' || decision.mode === 'block') {
      return { ok: false, decision };
    }

    const [roleRow] = await this.db.select().from(modelRoles).where(eq(modelRoles.role, role));
    if (!roleRow) throw new Error(`no model_roles row for role: ${role}`);

    let primaryId = roleRow.primaryModel;
    if (opts.modelOverride) {
      const [override] = await this.db
        .select()
        .from(models)
        .where(and(eq(models.id, opts.modelOverride), eq(models.enabled, true)));
      if (override) primaryId = override.id;
    }

    const degraded = decision.mode === 'fallback';
    const modelId = degraded ? roleRow.fallbackModel : primaryId;
    const params = (roleRow.params ?? {}) as Record<string, unknown>;

    return {
      ok: true,
      model: this.provider.chat(modelId),
      modelId,
      degraded,
      decision,
      params,
    };
  }

  private async meter(input: MeterInput): Promise<void> {
    const providerMetadata =
      input.event.providerMetadata ??
      (input.event as { finalStep?: { providerMetadata?: Record<string, unknown> } }).finalStep
        ?.providerMetadata;
    let costUsd = extractCost(providerMetadata);
    const inputTokens = input.event.usage?.inputTokens ?? 0;
    const outputTokens = input.event.usage?.outputTokens ?? 0;

    // Embedding calls don't report usage.cost — price them from the rate table
    // so embedding spend (batch imports!) is visible, not free.
    if (input.role === 'embed' && costUsd === 0 && inputTokens > 0) {
      const rate = await getRate(this.db, 'embedding_mtok').catch(() => null);
      if (rate) costUsd = (inputTokens / 1_000_000) * rate.unitPriceUsd;
    }

    await this.db.insert(modelCalls).values({
      taskId: input.taskId,
      role: input.role,
      model: input.modelId,
      inputTokens,
      outputTokens,
      costUsd: costUsd.toFixed(6),
      latencyMs: input.latencyMs,
      finishReason: input.event.finishReason,
      openrouterGenerationId: input.event.response?.id,
    });
    // Unified ledger (Phase 27): every model/embedding call is a cost event.
    await recordCostEvent(this.db, {
      source: input.role === 'embed' ? 'embedding' : 'model',
      usd: costUsd,
      taskId: input.taskId,
      quantity: inputTokens + outputTokens,
      unit: 'tokens',
      description: `${input.role}:${input.modelId}`,
    }).catch((err) => console.error('cost event write failed', err));
    if (input.taskId && costUsd > 0) {
      await this.db
        .update(tasks)
        .set({ spentUsd: sql`${tasks.spentUsd} + ${costUsd.toFixed(6)}`, updatedAt: sql`now()` })
        .where(eq(tasks.id, input.taskId));
    }
  }

  /** Non-streaming call with metering. Callers must handle { ok: false }. */
  async generate(role: ModelRole, opts: CallOptions): Promise<GenerateOutcome> {
    const route = await this.route(role, opts);
    if (!route.ok) return { ok: false, decision: route.decision };

    const started = Date.now();
    return withSpan('model.generate', { role, model: route.modelId }, async () => {
      const result = await generateText({
        model: route.model,
        system: opts.system,
        ...promptArgs(opts),
        temperature: opts.temperature ?? (route.params.temperature as number | undefined),
        maxOutputTokens:
          opts.maxOutputTokens ?? (route.params.maxOutputTokens as number | undefined),
        abortSignal: opts.abortSignal,
      });
      await this.meter({
        taskId: opts.taskId,
        role,
        modelId: route.modelId,
        latencyMs: Date.now() - started,
        event: result as FinishEventLike,
      });
      return {
        ok: true as const,
        modelId: route.modelId,
        degraded: route.degraded,
        text: result.text,
        finishReason: result.finishReason,
      };
    });
  }

  /**
   * Streaming call. Metering happens in onFinish (fire-and-forget) so the
   * stream is never blocked on a DB write. onComplete runs after metering
   * with the final text — use it to persist the assistant message.
   */
  async stream(
    role: ModelRole,
    opts: CallOptions & { onComplete?: (text: string) => Promise<void> },
  ): Promise<StreamOutcome> {
    const route = await this.route(role, opts);
    if (!route.ok) return { ok: false, decision: route.decision };

    const started = Date.now();
    const result = streamText({
      model: route.model,
      system: opts.system,
      ...promptArgs(opts),
      temperature: opts.temperature ?? (route.params.temperature as number | undefined),
      maxOutputTokens: opts.maxOutputTokens ?? (route.params.maxOutputTokens as number | undefined),
      abortSignal: opts.abortSignal,
      onFinish: (event: FinishEventLike & { text?: string }) => {
        void this.meter({
          taskId: opts.taskId,
          role,
          modelId: route.modelId,
          latencyMs: Date.now() - started,
          event,
        })
          .then(() => opts.onComplete?.(event.text ?? ''))
          .catch((err) => console.error('stream finish handling failed', err));
      },
    });

    const narrowed = result as unknown as {
      text: PromiseLike<string>;
      toUIMessageStreamResponse: (options?: Record<string, unknown>) => Response;
    };
    return {
      ok: true,
      modelId: route.modelId,
      degraded: route.degraded,
      text: narrowed.text,
      toUIMessageStreamResponse: (options) => narrowed.toUIMessageStreamResponse(options),
    };
  }

  /**
   * One executor step: tools are passed WITHOUT execute functions, so the SDK
   * returns unexecuted tool calls — exactly what the risk gate needs.
   */
  async step(role: ModelRole, opts: CallOptions & { tools: ToolSet }): Promise<StepCallOutcome> {
    const route = await this.route(role, opts);
    if (!route.ok) return { ok: false, decision: route.decision };

    const started = Date.now();
    return withSpan('model.step', { role, model: route.modelId }, async () => {
      const result = await generateText({
        model: route.model,
        system: opts.system,
        ...promptArgs(opts),
        tools: opts.tools,
        temperature: opts.temperature ?? (route.params.temperature as number | undefined),
        maxOutputTokens:
          opts.maxOutputTokens ?? (route.params.maxOutputTokens as number | undefined),
        abortSignal: opts.abortSignal,
      });
      await this.meter({
        taskId: opts.taskId,
        role,
        modelId: route.modelId,
        latencyMs: Date.now() - started,
        event: result as FinishEventLike,
      });
      const toolCalls: ProposedToolCall[] = result.toolCalls.map((tc) => ({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: (tc.input ?? {}) as Record<string, unknown>,
      }));
      return {
        ok: true as const,
        modelId: route.modelId,
        degraded: route.degraded,
        text: result.text,
        toolCalls,
        finishReason: result.finishReason,
      };
    });
  }

  /** Structured output (planner, classifiers). Schema is a zod schema. */
  async object<T>(
    role: ModelRole,
    opts: CallOptions & { schema: ZodType<T> },
  ): Promise<ObjectOutcome<T>> {
    const route = await this.route(role, opts);
    if (!route.ok) return { ok: false, decision: route.decision };

    const started = Date.now();
    return withSpan('model.object', { role, model: route.modelId }, async () => {
      const result = await generateObject({
        model: route.model,
        system: opts.system,
        ...promptArgs(opts),
        schema: opts.schema,
        temperature: opts.temperature ?? (route.params.temperature as number | undefined),
        abortSignal: opts.abortSignal,
      });
      await this.meter({
        taskId: opts.taskId,
        role,
        modelId: route.modelId,
        latencyMs: Date.now() - started,
        event: result as unknown as FinishEventLike,
      });
      return {
        ok: true as const,
        modelId: route.modelId,
        degraded: route.degraded,
        object: result.object as T,
      };
    });
  }

  /** Embeddings via the embed role. */
  async embed(values: string[], opts: { taskId?: string } = {}): Promise<number[][]> {
    const [roleRow] = await this.db.select().from(modelRoles).where(eq(modelRoles.role, 'embed'));
    if (!roleRow) throw new Error('no model_roles row for role: embed');

    const started = Date.now();
    const { embeddings, usage } = await embedMany({
      model: this.provider.textEmbeddingModel(roleRow.primaryModel),
      values,
    });
    await this.meter({
      taskId: opts.taskId,
      role: 'embed',
      modelId: roleRow.primaryModel,
      latencyMs: Date.now() - started,
      event: { usage: { inputTokens: usage?.tokens ?? 0, outputTokens: 0 } },
    });
    return embeddings;
  }
}
