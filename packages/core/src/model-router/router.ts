import { type Db, modelCalls, modelRoles, models, tasks } from '@assistant/db';
import { createOpenRouter, type OpenRouterProvider } from '@openrouter/ai-sdk-provider';
import {
  embedMany,
  generateObject,
  generateText,
  type JSONValue,
  type LanguageModel,
  type ModelMessage,
  streamText,
  type ToolSet,
} from 'ai';
import { and, eq } from 'drizzle-orm';
import type { ZodType } from 'zod';
import {
  BudgetReservationError,
  costTotals,
  reconcileReservation,
  releaseReservation,
  reserveCost,
} from '../cost.js';
import { withSpan } from '../otel.js';
import { type BudgetDecision, evaluateBudget } from './budget.js';

export type ModelRole = 'plan' | 'classify' | 'extract' | 'draft' | 'reason' | 'rewrite' | 'embed';

export interface RouteOptions {
  taskId?: string;
  /** Explicit model pick (chat switcher). Must exist + be enabled; still budget-guarded. */
  modelOverride?: string;
  /** Use this role's configured fallback model even when the budget is healthy. */
  forceFallback?: boolean;
  /** Owner chat/SMS replies: hard caps degrade instead of blocking (carve-out). */
  critical?: boolean;
}

export type Route =
  | {
      ok: true;
      model: LanguageModel;
      modelId: string;
      degraded: boolean;
      /** Reasoning model (capability flag): needs its own token headroom. */
      thinking: boolean;
      decision: BudgetDecision;
      params: Record<string, unknown>;
      promptCostPerMTok: number;
      completionCostPerMTok: number;
    }
  | { ok: false; decision: Extract<BudgetDecision, { mode: 'park' | 'block' }> };

export interface CallOptions {
  taskId?: string;
  modelOverride?: string;
  /** Use this role's configured fallback model even when the budget is healthy. */
  forceFallback?: boolean;
  /** Owner chat/SMS replies: hard caps degrade instead of blocking (carve-out). */
  critical?: boolean;
  system?: string;
  messages?: ModelMessage[];
  prompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}

/** The small tool-choice surface the workflow needs from the AI SDK. */
export type StepToolChoice = 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string };

/**
 * Providers that enforce OpenAI's function-name pattern (^[a-zA-Z0-9_-]{1,128}$)
 * reject this project's dotted tool names outright — the request fails before
 * the model ever sees the tools, which looks identical to a model that simply
 * declined to call anything. Swap dots for underscores on the wire and undo it
 * on the way back, so only the provider sees the encoded form.
 */
export function encodeToolNames(tools: ToolSet): {
  encoded: ToolSet;
  decode: (name: string) => string;
} {
  const canonical = new Map<string, string>();
  const encoded: ToolSet = {};
  for (const [name, definition] of Object.entries(tools)) {
    const wireName = name.replace(/\./g, '_');
    const collision = canonical.get(wireName);
    if (collision && collision !== name) {
      throw new Error(`tool names "${collision}" and "${name}" both encode to "${wireName}"`);
    }
    canonical.set(wireName, name);
    encoded[wireName] = definition;
  }
  return { encoded, decode: (name) => canonical.get(name) ?? name };
}

/**
 * The checkpointed context window records canonical tool names in its
 * tool-call/tool-result parts. Those names are replayed to the provider on
 * every later step, so they need the same wire encoding as the tool defs —
 * otherwise a task calls a tool successfully on step 0 and then fails on
 * step 1 when its own history is rejected.
 */
function encodeMessageToolNames(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((part) =>
        part && typeof part === 'object' && 'toolName' in part && typeof part.toolName === 'string'
          ? { ...part, toolName: part.toolName.replace(/\./g, '_') }
          : part,
      ),
    } as ModelMessage;
  });
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
  reservationId: string;
  promptCostPerMTok: number;
  completionCostPerMTok: number;
}

const DEFAULT_MAX_OUTPUT_TOKENS: Record<Exclude<ModelRole, 'embed'>, number> = {
  plan: 1_024,
  classify: 512,
  extract: 1_024,
  draft: 2_048,
  reason: 4_096,
  rewrite: 2_048,
};
const HARD_MAX_OUTPUT_TOKENS = 4_096;
const ESTIMATE_SAFETY_FACTOR = 1.25;
// OpenRouter load-balances each request across upstream providers, and the
// slow tail is real: successful deepseek-chat calls on goal-session prompts
// have been observed at 97–118s in prod. 120s cut those off mid-generation
// (billed but discarded); 150s clears the observed tail while staying far
// inside the executor's 900s request window and 10-min heartbeated lease.
const MODEL_CALL_TIMEOUT_MS = 150_000;

/**
 * Reasoning ("thinking") models spend completion tokens on hidden reasoning
 * before the visible answer, and that reasoning is billed against the same
 * `max_tokens` budget. If reasoning shares the visible-output budget it starves
 * — or entirely preempts — the answer: the model stops at finishReason 'length'
 * with truncated or empty text (the "request failed after thinking" chat
 * turns, plus triage/classify JSON that never lands). Give reasoning its own
 * bounded headroom on top of the visible budget, and cap it via OpenRouter so
 * the answer always keeps its full allocation. Only thinking models (capability
 * flag on the model row) get this; plain models are unaffected.
 */
const REASONING_HEADROOM_TOKENS = 4_096;

/** Structural match for the AI SDK's `providerOptions` param ({ provider: { ... } }). */
type ProviderOptions = Record<string, Record<string, JSONValue>>;

function modelCallSignal(signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(MODEL_CALL_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
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

function estimatedInputTokens(opts: CallOptions): number {
  const content = opts.messages ? JSON.stringify(opts.messages) : (opts.prompt ?? '');
  // UTF-8/token ratios vary substantially across languages and structured tool
  // payloads. Two characters per token is deliberately conservative.
  return Math.max(1, Math.ceil(((opts.system?.length ?? 0) + content.length) / 2));
}

function reservationDecision(reason: string): Extract<BudgetDecision, { mode: 'park' | 'block' }> {
  return { mode: reason.startsWith('task budget') ? 'park' : 'block', reason };
}

/**
 * True when generateObject failed because the model's response could not be
 * parsed into the schema (the AI SDK's AI_NoObjectGeneratedError) — a *quality*
 * failure of a weak model, not a transient/provider one. Detected by name so it
 * does not depend on the SDK re-exporting the error class. Callers use this to
 * retry on a stronger model and, failing that, skip the single item rather than
 * fail (and eventually dead-letter) an entire durable job.
 */
export function isUnparseableObjectError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AI_NoObjectGeneratedError' || err.name === 'NoObjectGeneratedError')
  );
}

/**
 * The per-call deadline (modelCallSignal) aborts with a DOMException named
 * TimeoutError. Only that deadline produces this name inside a model call, so
 * it is safe to treat as "this one provider request was too slow" rather than
 * "the caller cancelled us".
 */
function isModelCallTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

/**
 * True when a provider rejected the *shape* of the request rather than
 * failing transiently — e.g. Novita serving deepseek-chat answers
 * "response format json_schema is not supported", and OpenRouter itself
 * reports an empty provider pool when routing preferences exclude everyone.
 * These never heal by retrying the same model: the cure is the role's
 * fallback model, whose provider pool is different. Kept deliberately
 * narrow so genuinely transient APICallErrors (429/5xx) stay with the
 * task-level retry.
 */
export function isProviderCapabilityError(err: unknown): boolean {
  if (!(err instanceof Error) || err.name !== 'AI_APICallError') return false;
  return /not supported|no endpoints? (found|match)|no allowed providers/i.test(err.message);
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

    const degraded = opts.forceFallback || decision.mode === 'fallback';
    const modelId = degraded ? roleRow.fallbackModel : primaryId;
    const params = (roleRow.params ?? {}) as Record<string, unknown>;
    const [modelRow] = await this.db.select().from(models).where(eq(models.id, modelId));
    if (!modelRow) throw new Error(`model row missing for routed model: ${modelId}`);
    const promptCostPerMTok = Number(modelRow.promptCostPerMTok);
    const completionCostPerMTok = Number(modelRow.completionCostPerMTok);
    if (
      modelRow.promptCostPerMTok === null ||
      modelRow.completionCostPerMTok === null ||
      !Number.isFinite(promptCostPerMTok) ||
      !Number.isFinite(completionCostPerMTok)
    ) {
      throw new Error(`model ${modelId} is missing cost rates; refusing an unbudgeted call`);
    }
    const capabilities = (modelRow.capabilities ?? {}) as { thinking?: boolean };

    return {
      ok: true,
      // require_parameters: OpenRouter must only route to providers that
      // support everything this request sends (json_schema response format,
      // tools, …). Without it a structured-output call is a lottery — e.g.
      // deepseek-chat is also served by providers with no structured-output
      // support, which hard-fail the request. Per-request semantics: plain
      // text calls still use the full provider pool.
      model: this.provider.chat(modelId, { provider: { require_parameters: true } }),
      modelId,
      degraded,
      thinking: capabilities.thinking === true,
      decision,
      params,
      promptCostPerMTok,
      completionCostPerMTok,
    };
  }

  private outputLimit(
    role: Exclude<ModelRole, 'embed'>,
    route: Extract<Route, { ok: true }>,
    opts: CallOptions,
  ): number {
    const configured = opts.maxOutputTokens ?? (route.params.maxOutputTokens as number | undefined);
    const requested = configured ?? DEFAULT_MAX_OUTPUT_TOKENS[role];
    if (!Number.isFinite(requested) || requested <= 0) {
      throw new Error('maxOutputTokens must be a positive finite number');
    }
    return Math.min(Math.floor(requested), HARD_MAX_OUTPUT_TOKENS);
  }

  /**
   * The completion budget to send the provider, plus any provider options.
   * A thinking model gets bounded reasoning headroom on top of the visible
   * answer budget (and OpenRouter is told to keep reasoning within it), so the
   * answer never truncates at finishReason 'length'. The inflated total also
   * flows into the cost reservation below — reasoning tokens are billed, so
   * reserving for them keeps the budget guard honest. Plain models are
   * unchanged: same limit, no provider options.
   */
  private modelCallBudget(
    role: Exclude<ModelRole, 'embed'>,
    route: Extract<Route, { ok: true }>,
    opts: CallOptions,
  ): { maxOutputTokens: number; providerOptions?: ProviderOptions } {
    const visibleLimit = this.outputLimit(role, route, opts);
    if (!route.thinking) return { maxOutputTokens: visibleLimit };
    return {
      maxOutputTokens: visibleLimit + REASONING_HEADROOM_TOKENS,
      providerOptions: {
        openrouter: { reasoning: { max_tokens: REASONING_HEADROOM_TOKENS } },
      },
    };
  }

  private async reserveModelCall(
    role: Exclude<ModelRole, 'embed'>,
    route: Extract<Route, { ok: true }>,
    opts: CallOptions,
  ) {
    const { maxOutputTokens, providerOptions } = this.modelCallBudget(role, route, opts);
    const inputTokens = estimatedInputTokens(opts);
    const estimatedUsd = Math.max(
      0.000001,
      ((inputTokens * route.promptCostPerMTok + maxOutputTokens * route.completionCostPerMTok) /
        1_000_000) *
        ESTIMATE_SAFETY_FACTOR,
    );
    const reservation = await reserveCost(this.db, {
      source: 'model',
      estimatedUsd,
      taskId: opts.taskId,
      description: `${role}:${route.modelId} preflight`,
      critical: opts.critical,
    });
    return { reservation, maxOutputTokens, providerOptions };
  }

  /**
   * Route and reserve a model call as one budget-aware decision. The routing
   * guard can only see money already spent; a large primary-model reservation
   * may still fail even when the task is below its soft threshold. Because no
   * provider work has happened at that point, retry the preflight with the
   * cheaper fallback before asking the owner for more budget.
   */
  private async prepareModelCall(
    role: Exclude<ModelRole, 'embed'>,
    opts: CallOptions,
  ): Promise<
    | { ok: false; decision: Extract<BudgetDecision, { mode: 'park' | 'block' }> }
    | {
        ok: true;
        route: Extract<Route, { ok: true }>;
        reservationId: string;
        maxOutputTokens: number;
        providerOptions?: ProviderOptions;
      }
  > {
    const attempt = async (forceFallback: boolean) => {
      const route = await this.route(role, { ...opts, forceFallback });
      if (!route.ok) return { ok: false as const, decision: route.decision };
      const prepared = await this.reserveModelCall(role, route, opts);
      if (!prepared.reservation.ok) {
        return {
          ok: false as const,
          decision: reservationDecision(prepared.reservation.reason),
          route,
        };
      }
      return {
        ok: true as const,
        route,
        reservationId: prepared.reservation.reservationId,
        maxOutputTokens: prepared.maxOutputTokens,
        providerOptions: prepared.providerOptions,
      };
    };

    const preferred = await attempt(Boolean(opts.forceFallback));
    if (preferred.ok || !preferred.route || preferred.route.degraded) return preferred;

    const fallback = await attempt(true);
    // A role may intentionally point primary and fallback at the same model.
    // Preserve the first failure instead of repeating the identical decision.
    if (fallback.route?.modelId === preferred.route.modelId) return preferred;
    return fallback;
  }

  /**
   * Run a prepare+call sequence, retrying ONCE when it dies on the per-call
   * deadline. Each OpenRouter request is load-balanced across upstream
   * providers, so a timeout is usually a per-request lottery loss (one slow
   * or degraded provider), not a property of the model — and without this,
   * that single slow request burns an entire task attempt: checkpoint reseed,
   * exponential backoff, and a re-billed context window. The retry re-runs
   * preparation, so budget routing and the cost reservation stay honest (the
   * timed-out try already released its hold). A caller whose own abortSignal
   * has fired is not retried — that deadline is not ours to extend.
   */
  private async withTimeoutRetry<T>(opts: CallOptions, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (!isModelCallTimeout(err) || opts.abortSignal?.aborted) throw err;
      return await run();
    }
  }

  private async meter(input: MeterInput): Promise<void> {
    const providerMetadata =
      input.event.providerMetadata ??
      (input.event as { finalStep?: { providerMetadata?: Record<string, unknown> } }).finalStep
        ?.providerMetadata;
    let costUsd = extractCost(providerMetadata);
    const inputTokens = input.event.usage?.inputTokens ?? 0;
    const outputTokens = input.event.usage?.outputTokens ?? 0;

    // Provider cost is authoritative. If it is absent, fail closed to the
    // configured rate table rather than silently treating a paid call as free.
    if (costUsd === 0 && inputTokens + outputTokens > 0) {
      costUsd =
        (inputTokens * input.promptCostPerMTok + outputTokens * input.completionCostPerMTok) /
        1_000_000;
    }

    // Reconcile the budget hold first. If the secondary model-call telemetry
    // insert fails, spend is still safely accounted and the paid provider call
    // must not be repeated.
    await reconcileReservation(this.db, input.reservationId, {
      usd: costUsd,
      quantity: inputTokens + outputTokens,
      unit: 'tokens',
      unitPriceUsd:
        inputTokens + outputTokens > 0 ? costUsd / (inputTokens + outputTokens) : undefined,
      description: `${input.role}:${input.modelId}`,
    });
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
  }

  private async meterWithoutRepeatingProviderWork(input: MeterInput): Promise<void> {
    try {
      await this.meter(input);
    } catch (err) {
      // The provider call already happened. Throwing here would make the
      // workflow repeat paid/non-idempotent model work. Keep the reservation
      // held as a conservative backstop; maintenance releases truly orphaned
      // holds after the crash window.
      console.error('model metering failed after provider success', err);
    }
  }

  /** Non-streaming call with metering. Callers must handle { ok: false }. */
  async generate(role: ModelRole, opts: CallOptions): Promise<GenerateOutcome> {
    if (role === 'embed') throw new Error('generate() cannot use the embed role');
    return this.withTimeoutRetry(opts, () => this.generateOnce(role, opts));
  }

  private async generateOnce(
    role: Exclude<ModelRole, 'embed'>,
    opts: CallOptions,
  ): Promise<GenerateOutcome> {
    const prepared = await this.prepareModelCall(role, opts);
    if (!prepared.ok) return prepared;
    const { route, reservationId, maxOutputTokens, providerOptions } = prepared;

    const started = Date.now();
    try {
      return await withSpan('model.generate', { role, model: route.modelId }, async () => {
        const result = await generateText({
          model: route.model,
          system: opts.system,
          ...promptArgs(opts),
          temperature: opts.temperature ?? (route.params.temperature as number | undefined),
          maxOutputTokens,
          providerOptions,
          abortSignal: modelCallSignal(opts.abortSignal),
        });
        await this.meterWithoutRepeatingProviderWork({
          taskId: opts.taskId,
          role,
          modelId: route.modelId,
          latencyMs: Date.now() - started,
          event: result as FinishEventLike,
          reservationId,
          promptCostPerMTok: route.promptCostPerMTok,
          completionCostPerMTok: route.completionCostPerMTok,
        });
        return {
          ok: true as const,
          modelId: route.modelId,
          degraded: route.degraded,
          text: result.text,
          finishReason: result.finishReason,
        };
      });
    } catch (err) {
      await releaseReservation(this.db, reservationId).catch(() => {});
      throw err;
    }
  }

  /**
   * Streaming call. The AI SDK awaits onFinish, so metering and durable reply
   * persistence finish before the response stream is allowed to close.
   */
  async stream(
    role: ModelRole,
    opts: CallOptions & {
      onComplete?: (text: string) => Promise<void>;
      onError?: (error: unknown) => Promise<void>;
    },
  ): Promise<StreamOutcome> {
    if (role === 'embed') throw new Error('stream() cannot use the embed role');
    const prepared = await this.prepareModelCall(role, opts);
    if (!prepared.ok) return prepared;
    const { route, reservationId, maxOutputTokens, providerOptions } = prepared;

    const started = Date.now();
    let result: ReturnType<typeof streamText>;
    try {
      result = streamText({
        model: route.model,
        system: opts.system,
        ...promptArgs(opts),
        temperature: opts.temperature ?? (route.params.temperature as number | undefined),
        maxOutputTokens,
        providerOptions,
        abortSignal: modelCallSignal(opts.abortSignal),
        onFinish: async (event: FinishEventLike & { text?: string }) => {
          // AI SDK pauses stream finalization until this promise resolves. Run
          // persistence independently so a ledger failure cannot lose a reply.
          await Promise.all([
            this.meterWithoutRepeatingProviderWork({
              taskId: opts.taskId,
              role,
              modelId: route.modelId,
              latencyMs: Date.now() - started,
              event,
              reservationId,
              promptCostPerMTok: route.promptCostPerMTok,
              completionCostPerMTok: route.completionCostPerMTok,
            }),
            opts.onComplete?.(event.text ?? '') ?? Promise.resolve(),
          ]);
        },
        onError: async ({ error }: { error: unknown }) => {
          await releaseReservation(this.db, reservationId).catch(() => {});
          if (opts.onError) {
            await opts.onError(error).catch((callbackError) => {
              console.error('stream error callback failed', callbackError);
            });
          }
        },
        onAbort: async () => {
          const error = new Error('model stream aborted');
          await releaseReservation(this.db, reservationId).catch(() => {});
          if (opts.onError) {
            await opts.onError(error).catch((callbackError) => {
              console.error('stream abort callback failed', callbackError);
            });
          }
        },
      });
    } catch (err) {
      await releaseReservation(this.db, reservationId).catch(() => {});
      throw err;
    }

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
   *
   * Tool names are wire-encoded here (see encodeToolNames): this project names
   * tools 'web.fetch', but several providers enforce the OpenAI function-name
   * pattern, which forbids dots and rejects the whole request. Encoding at the
   * model boundary keeps canonical dotted names everywhere else — the risk
   * gate, approvals, tool_calls rows and the response contract all still see
   * 'web.fetch'.
   */
  async step(
    role: ModelRole,
    opts: CallOptions & { tools: ToolSet; toolChoice?: StepToolChoice },
  ): Promise<StepCallOutcome> {
    if (role === 'embed') throw new Error('step() cannot use the embed role');
    return this.withTimeoutRetry(opts, () => this.stepOnce(role, opts));
  }

  private async stepOnce(
    role: Exclude<ModelRole, 'embed'>,
    opts: CallOptions & { tools: ToolSet; toolChoice?: StepToolChoice },
  ): Promise<StepCallOutcome> {
    const prepared = await this.prepareModelCall(role, opts);
    if (!prepared.ok) return prepared;
    const { route, reservationId, maxOutputTokens, providerOptions } = prepared;

    const { encoded, decode } = encodeToolNames(opts.tools);
    const toolChoice =
      opts.toolChoice && typeof opts.toolChoice === 'object'
        ? { ...opts.toolChoice, toolName: opts.toolChoice.toolName.replace(/\./g, '_') }
        : opts.toolChoice;

    const started = Date.now();
    try {
      return await withSpan('model.step', { role, model: route.modelId }, async () => {
        const result = await generateText({
          model: route.model,
          system: opts.system,
          ...promptArgs({
            ...opts,
            messages: opts.messages ? encodeMessageToolNames(opts.messages) : undefined,
          }),
          tools: encoded,
          toolChoice: toolChoice as never,
          temperature: opts.temperature ?? (route.params.temperature as number | undefined),
          maxOutputTokens,
          providerOptions,
          abortSignal: modelCallSignal(opts.abortSignal),
        });
        await this.meterWithoutRepeatingProviderWork({
          taskId: opts.taskId,
          role,
          modelId: route.modelId,
          latencyMs: Date.now() - started,
          event: result as FinishEventLike,
          reservationId,
          promptCostPerMTok: route.promptCostPerMTok,
          completionCostPerMTok: route.completionCostPerMTok,
        });
        const toolCalls: ProposedToolCall[] = result.toolCalls.map((tc) => ({
          toolCallId: tc.toolCallId,
          toolName: decode(tc.toolName),
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
    } catch (err) {
      await releaseReservation(this.db, reservationId).catch(() => {});
      throw err;
    }
  }

  /** Structured output (planner, classifiers). Schema is a zod schema. */
  async object<T>(
    role: ModelRole,
    opts: CallOptions & { schema: ZodType<T> },
  ): Promise<ObjectOutcome<T>> {
    if (role === 'embed') throw new Error('object() cannot use the embed role');

    const runOnce = async (forceFallback: boolean): Promise<ObjectOutcome<T>> => {
      const prepared = await this.prepareModelCall(role, {
        ...opts,
        forceFallback: forceFallback || opts.forceFallback,
      });
      if (!prepared.ok) return prepared;
      const { route, reservationId, maxOutputTokens, providerOptions } = prepared;

      const started = Date.now();
      try {
        return await withSpan('model.object', { role, model: route.modelId }, async () => {
          const result = await generateObject({
            model: route.model,
            system: opts.system,
            ...promptArgs(opts),
            schema: opts.schema,
            temperature: opts.temperature ?? (route.params.temperature as number | undefined),
            maxOutputTokens,
            providerOptions,
            abortSignal: modelCallSignal(opts.abortSignal),
          });
          await this.meterWithoutRepeatingProviderWork({
            taskId: opts.taskId,
            role,
            modelId: route.modelId,
            latencyMs: Date.now() - started,
            event: result as unknown as FinishEventLike,
            reservationId,
            promptCostPerMTok: route.promptCostPerMTok,
            completionCostPerMTok: route.completionCostPerMTok,
          });
          return {
            ok: true as const,
            modelId: route.modelId,
            degraded: route.degraded,
            object: result.object as T,
          };
        });
      } catch (err) {
        await releaseReservation(this.db, reservationId).catch(() => {});
        throw err;
      }
    };

    const attempt = (forceFallback: boolean) =>
      this.withTimeoutRetry(opts, () => runOnce(forceFallback));

    try {
      return await attempt(false);
    } catch (err) {
      // Two error classes get one shot on the role's fallback model before
      // surfacing, because both are properties of the primary model rather
      // than transient: schema output a weak primary cannot parse
      // (AI_NoObjectGeneratedError), and provider-capability rejections
      // (e.g. "response format json_schema is not supported") where the
      // primary's provider pool cannot serve the request shape at all —
      // otherwise a durable job retries the same primary on every attempt
      // and dead-letters. Any other error (transport, 429/5xx) is genuinely
      // transient and is left to the caller's retry.
      if (
        opts.forceFallback ||
        !(isUnparseableObjectError(err) || isProviderCapabilityError(err))
      ) {
        throw err;
      }
      try {
        return await attempt(true);
      } catch {
        // No usable fallback, or it also failed: surface the original
        // failure so the caller can skip this item.
        throw err;
      }
    }
  }

  /** Embeddings via the embed role. */
  async embed(values: string[], opts: { taskId?: string } = {}): Promise<number[][]> {
    const [roleRow] = await this.db.select().from(modelRoles).where(eq(modelRoles.role, 'embed'));
    if (!roleRow) throw new Error('no model_roles row for role: embed');
    if (values.length === 0) return [];
    if (values.length > 100) throw new Error('embedding batch exceeds 100 values');
    const [modelRow] = await this.db
      .select()
      .from(models)
      .where(eq(models.id, roleRow.primaryModel));
    const promptCostPerMTok = Number(modelRow?.promptCostPerMTok);
    if (!modelRow || modelRow.promptCostPerMTok === null || !Number.isFinite(promptCostPerMTok)) {
      throw new Error(`embedding model ${roleRow.primaryModel} is missing a cost rate`);
    }
    const inputTokens = Math.max(
      1,
      Math.ceil(values.reduce((n, value) => n + value.length, 0) / 2),
    );
    const reservation = await reserveCost(this.db, {
      source: 'embedding',
      estimatedUsd: Math.max(
        0.000001,
        ((inputTokens * promptCostPerMTok) / 1_000_000) * ESTIMATE_SAFETY_FACTOR,
      ),
      taskId: opts.taskId,
      description: `embed:${roleRow.primaryModel} preflight`,
    });
    if (!reservation.ok) throw new BudgetReservationError(reservation.reason, reservation.resumeAt);

    const started = Date.now();
    try {
      const { embeddings, usage } = await embedMany({
        model: this.provider.textEmbeddingModel(roleRow.primaryModel),
        values,
        maxParallelCalls: 4,
        abortSignal: modelCallSignal(),
      });
      await this.meterWithoutRepeatingProviderWork({
        taskId: opts.taskId,
        role: 'embed',
        modelId: roleRow.primaryModel,
        latencyMs: Date.now() - started,
        event: { usage: { inputTokens: usage?.tokens ?? inputTokens, outputTokens: 0 } },
        reservationId: reservation.reservationId,
        promptCostPerMTok,
        completionCostPerMTok: 0,
      });
      return embeddings;
    } catch (err) {
      await releaseReservation(this.db, reservation.reservationId).catch(() => {});
      throw err;
    }
  }
}
