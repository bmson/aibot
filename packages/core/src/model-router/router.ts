import { loadConfig } from '@assistant/config';
import { createPostgresModelRoutingRepository, type Db } from '@assistant/db';
import type { ModelRoutingRepository } from '@assistant/persistence';
import {
  type EmbeddingModel,
  embedMany,
  generateObject,
  generateText,
  type LanguageModel,
  type ModelMessage,
  streamText,
  type ToolSet,
} from 'ai';
import type { ZodType } from 'zod';
import {
  BudgetReservationError,
  costTotals,
  reconcileReservation,
  releaseReservation,
  reserveCost,
} from '../cost.js';
import { withSpan } from '../otel.js';
import { type AuditCaptureMode, captureField, captureInput } from './audit-capture.js';
import { type BudgetDecision, evaluateBudget } from './budget.js';
import {
  createOpenRouterModelProvider,
  type ModelProvider,
  type ProviderOptions,
  type ProviderUsage,
} from './provider.js';

export type ModelRole =
  | 'plan'
  | 'classify'
  | 'extract'
  | 'draft'
  | 'reason'
  | 'rewrite'
  | 'embed'
  | 'batch';

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
  | { ok: true; modelId: string; degraded: boolean; object: T; finishReason?: string };

/**
 * A structured-output call whose response was cut off at the token limit
 * (finishReason 'length') even after a fallback retry. The object still parses
 * (a truncated string is schema-valid), so without this the caller would accept
 * a half-formed value — the source of the truncated "Are you" clarify question.
 */
export class TruncatedObjectError extends Error {
  constructor(role: string) {
    super(`structured output for role '${role}' was truncated at the token limit`);
    this.name = 'TruncatedObjectError';
  }
}

export type StreamOutcome =
  | { ok: false; decision: Extract<BudgetDecision, { mode: 'park' | 'block' }> }
  | {
      ok: true;
      modelId: string;
      degraded: boolean;
      text: PromiseLike<string>;
      toUIMessageStreamResponse: (options?: Record<string, unknown>) => Response;
      // Raw part stream for callers that compose their own UI message stream
      // (e.g. to append a post-draft part) instead of taking a Response. The
      // SDK's AsyncIterableStream surfaces as both shapes.
      toUIMessageStream: (
        options?: Record<string, unknown>,
      ) => ReadableStream<unknown> & AsyncIterable<unknown>;
    };

/** Loose supertype of the AI SDK finish events — only what metering reads. */
interface FinishEventLike {
  usage?: { inputTokens?: number; outputTokens?: number };
  providerMetadata?: Record<string, unknown>;
  response?: { id?: string };
  responses?: unknown[];
  finishReason?: string;
}

interface EmbeddingProviderEvidence {
  usage?: { tokens?: number };
  providerMetadata?: Record<string, unknown>;
}

function observeEmbeddingModel(
  model: EmbeddingModel,
  evidence: EmbeddingProviderEvidence[],
): {
  model: EmbeddingModel;
  stop: () => void;
  waitForSettled: () => Promise<void>;
} {
  if (typeof model !== 'object' || model === null || !('doEmbed' in model)) {
    return { model, stop: () => {}, waitForSettled: async () => {} };
  }
  const candidate = model as {
    doEmbed?: (options: unknown) => PromiseLike<EmbeddingProviderEvidence>;
  };
  const doEmbed = candidate.doEmbed;
  if (typeof doEmbed !== 'function') {
    return { model, stop: () => {}, waitForSettled: async () => {} };
  }
  let stopped = false;
  const inFlight = new Set<Promise<EmbeddingProviderEvidence>>();
  let observedDoEmbed: ((options: unknown) => Promise<EmbeddingProviderEvidence>) | undefined;
  const observed = new Proxy(model as object, {
    get(target, property) {
      if (property === 'doEmbed') return observedDoEmbed;
      return Reflect.get(target, property, target);
    },
  }) as typeof candidate;
  observedDoEmbed = async (options) => {
    if (stopped) throw new Error('embedding batch stopped after provider failure');
    const operation = (async () => {
      const result = await doEmbed.call(model, options);
      evidence.push(result);
      return result;
    })();
    inFlight.add(operation);
    operation.then(
      () => inFlight.delete(operation),
      () => {
        stopped = true;
        inFlight.delete(operation);
      },
    );
    return operation;
  };
  return {
    model: observed as EmbeddingModel,
    stop: () => {
      stopped = true;
    },
    waitForSettled: async () => {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}

function validTokenCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 2_147_483_647
  );
}

function providerResultFromError(error: unknown): FinishEventLike | undefined {
  if (!isUnparseableObjectError(error) || !(error instanceof Error)) return undefined;
  const candidate = error as Error & FinishEventLike;
  if (!candidate.usage && !candidate.providerMetadata && !candidate.response) return undefined;
  return candidate;
}

function aggregateEmbeddingUsage(
  provider: ModelProvider,
  evidence: EmbeddingProviderEvidence[],
): ProviderUsage | undefined {
  if (evidence.length === 0) return undefined;
  let inputTokens = 0;
  let tokensKnown = true;
  let costUsd = 0;
  let costKnown = true;
  for (const result of evidence) {
    const usage = provider.normalizeUsage({
      usage: result.usage ? { inputTokens: result.usage.tokens, outputTokens: 0 } : undefined,
      providerMetadata: result.providerMetadata,
    });
    if (validTokenCount(usage.inputTokens)) {
      inputTokens += usage.inputTokens;
    } else {
      tokensKnown = false;
    }
    if (typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) {
      costUsd += usage.costUsd;
    } else {
      costKnown = false;
    }
  }
  const aggregateTokens = tokensKnown && validTokenCount(inputTokens) ? inputTokens : undefined;
  return {
    inputTokens: aggregateTokens,
    outputTokens: aggregateTokens === undefined ? undefined : 0,
    costUsd: costKnown && Number.isFinite(costUsd) ? costUsd : undefined,
  };
}

interface MeterInput {
  taskId?: string;
  role: string;
  modelId: string;
  latencyMs: number;
  event: FinishEventLike;
  reservationId: string;
  estimatedUsd: number;
  usageOverride?: ProviderUsage;
  promptCostPerMTok: number;
  completionCostPerMTok: number;
  /**
   * What to keep for quality review, when capture is enabled. Absent on the
   * embed path: an embedding has no answer to judge.
   */
  audit?: AuditPayload;
}

/** The reviewable half of a call: what it was asked, and what it said back. */
interface AuditPayload {
  method: 'generate' | 'stream' | 'step' | 'object';
  system?: string;
  input?: string;
  output?: string;
}

/** Structured output as reviewable text, never at the cost of the audit write. */
function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

/** A step's prose plus the calls it chose, so a tool-calling turn reads as one. */
function stepOutputForAudit(
  text: string,
  toolCalls: ReadonlyArray<{ toolName: string; input?: unknown }>,
): string | undefined {
  const calls = toolCalls.map((tc) => `→ ${tc.toolName}(${safeJson(tc.input) ?? ''})`);
  const parts = [text.trim(), ...calls].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

const DEFAULT_MAX_OUTPUT_TOKENS: Record<Exclude<ModelRole, 'embed'>, number> = {
  plan: 1_024,
  classify: 512,
  extract: 1_024,
  draft: 2_048,
  reason: 4_096,
  rewrite: 2_048,
  batch: 4_096,
};
const HARD_MAX_OUTPUT_TOKENS = 4_096;
const ESTIMATE_SAFETY_FACTOR = 1.25;
export const EMBEDDING_DIMENSIONS = 1_536;
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

function modelCallSignal(signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(MODEL_CALL_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

function promptArgs(opts: CallOptions): { messages: ModelMessage[] } | { prompt: string } {
  if (opts.messages) return { messages: opts.messages };
  if (opts.prompt !== undefined) return { prompt: opts.prompt };
  throw new Error('model call needs messages or prompt');
}

function estimatedInputTokens(opts: CallOptions): number {
  const content = opts.messages ? JSON.stringify(opts.messages) : (opts.prompt ?? '');
  // ~3.5 chars/token holds for English prose and JSON tool payloads. The old
  // /2 estimate was ~2x pessimistic, which inflated every reservation and
  // tripped the soft budget threshold on spend that never materialized.
  return Math.max(1, Math.ceil(((opts.system?.length ?? 0) + content.length) / 3.5));
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
  private provider: ModelProvider;
  private readonly persistence: ModelRoutingRepository;

  constructor(
    store: Db | ModelRoutingRepository,
    apiKey: string,
    /**
     * Whether to keep prompts and answers for quality review. Resolved once,
     * here, rather than read deep in the call path: capture policy is a
     * property of this router, and a constructor argument is what lets a test
     * exercise both modes against a memoized config.
     */
    private auditCapture: AuditCaptureMode = loadConfig().LLM_AUDIT_CAPTURE,
    provider: ModelProvider = createOpenRouterModelProvider(apiKey),
  ) {
    this.provider = provider;
    this.persistence =
      'kind' in store && store.kind === 'model-routing-repository'
        ? (store as ModelRoutingRepository)
        : createPostgresModelRoutingRepository(store as Db);
  }

  /**
   * Budget snapshot for the guard. Daily/monthly spend comes from the unified
   * cost ledger (Phase 27) — model calls, embeddings, SMS, job-seconds — plus
   * estimated USD held by unreconciled reservations, so a launched job's
   * budget can't be double-spent before it reports actuals.
   */
  private async budgetSnapshot(taskId?: string) {
    const totals = await costTotals(this.persistence.costs);

    let taskLimitUsd: number | undefined;
    let taskSpentUsd: number | undefined;
    if (taskId) {
      const task = await this.persistence.taskBudget(taskId);
      if (task) {
        taskLimitUsd = Number(task.limit);
        taskSpentUsd = Number(task.spent);
      }
    }

    return {
      taskLimitUsd,
      taskSpentUsd,
      dailyLimitUsd: totals.dailyLimitUsd,
      dailySpentUsd: totals.dailySpentUsd,
      monthlyLimitUsd: totals.monthlyLimitUsd,
      monthlySpentUsd: totals.monthlySpentUsd,
      heldUsd: totals.heldUsd,
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

    const roleRow = await this.persistence.role(role);
    if (!roleRow) throw new Error(`no model_roles row for role: ${role}`);

    let primaryId = roleRow.primaryModel;
    let modelOverride = opts.modelOverride;
    // The conversation picker applies to tool-driven work as well as streamed
    // replies. Background planning/extraction keep their inexpensive role routes.
    if (!modelOverride && opts.taskId && (role === 'reason' || role === 'draft')) {
      modelOverride = (await this.persistence.conversationOverride(opts.taskId)) ?? undefined;
    }
    if (modelOverride) {
      const override = await this.persistence.model(modelOverride);
      if (override?.enabled && !(override.capabilities as { embedding?: boolean }).embedding) {
        primaryId = override.id;
      }
    }

    const degraded = opts.forceFallback || decision.mode === 'fallback';
    const modelId = degraded ? roleRow.fallbackModel : primaryId;
    const params = (roleRow.params ?? {}) as Record<string, unknown>;
    const modelRow = await this.persistence.model(modelId);
    if (!modelRow) throw new Error(`model row missing for routed model: ${modelId}`);
    if (!modelRow.enabled) throw new Error(`routed model is disabled: ${modelId}`);
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
    this.provider.assertModelId(modelId);
    const capabilities = (modelRow.capabilities ?? {}) as { thinking?: boolean };

    return {
      ok: true,
      // require_parameters: OpenRouter must only route to providers that
      // support everything this request sends (json_schema response format,
      // tools, …). Without it a structured-output call is a lottery — e.g.
      // deepseek-chat is also served by providers with no structured-output
      // support, which hard-fail the request. Per-request semantics: plain
      // text calls still use the full provider pool.
      model: this.provider.chat(modelId),
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
    if (!route.thinking) {
      return {
        maxOutputTokens: visibleLimit,
        providerOptions: this.provider.optionsFor({ thinking: false }),
      };
    }
    // Reasoning models still need headroom when a tool is mandatory. Removing
    // it can exhaust the completion budget before the tool call is emitted.
    return {
      maxOutputTokens: visibleLimit + REASONING_HEADROOM_TOKENS,
      providerOptions: this.provider.optionsFor({ thinking: true }),
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
    const reservation = await reserveCost(this.persistence.costs, {
      source: 'model',
      estimatedUsd,
      taskId: opts.taskId,
      description: `${role}:${route.modelId} preflight`,
      critical: opts.critical,
    });
    return { reservation, maxOutputTokens, providerOptions, estimatedUsd };
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
        estimatedUsd: number;
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
        estimatedUsd: prepared.estimatedUsd,
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
    const normalized = input.usageOverride ?? this.provider.normalizeUsage(input.event);
    const usage = {
      ...normalized,
      inputTokens: validTokenCount(normalized.inputTokens) ? normalized.inputTokens : undefined,
      outputTokens: validTokenCount(normalized.outputTokens) ? normalized.outputTokens : undefined,
      costUsd:
        typeof normalized.costUsd === 'number' &&
        Number.isFinite(normalized.costUsd) &&
        normalized.costUsd >= 0
          ? normalized.costUsd
          : undefined,
    };
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const completeTokenUsage = usage.inputTokens !== undefined && usage.outputTokens !== undefined;
    const hasPositiveTokenUsage = completeTokenUsage && inputTokens + outputTokens > 0;
    // embedMany may split a batch into several provider calls. Its aggregate
    // providerMetadata is a shallow merge of the last chunk, so never treat
    // that one cost as the total charge for a multi-response result.
    let costUsd =
      !input.usageOverride && input.event.responses && input.event.responses.length > 1
        ? undefined
        : usage.costUsd;

    // Provider cost is authoritative. If it is absent, fail closed to the
    // configured rate table rather than silently treating a paid call as free.
    let costDescription = `${input.role}:${input.modelId}`;
    if (costUsd === undefined && hasPositiveTokenUsage) {
      costUsd =
        (inputTokens * input.promptCostPerMTok + outputTokens * input.completionCostPerMTok) /
        1_000_000;
    }
    if (costUsd === undefined) {
      // A successful provider call with no usage is still paid work. Reconcile
      // to the positive preflight estimate so the hold cannot be refunded as
      // zero; the description keeps the conservative accounting visible.
      costUsd = input.estimatedUsd;
      costDescription = `${costDescription} estimated: provider usage unavailable`;
    }

    // Reconcile the budget hold first. If the secondary model-call telemetry
    // insert fails, spend is still safely accounted and the paid provider call
    // must not be repeated.
    await reconcileReservation(this.persistence.costs, input.reservationId, {
      usd: costUsd,
      ...(hasPositiveTokenUsage ? { quantity: inputTokens + outputTokens, unit: 'tokens' } : {}),
      unitPriceUsd: hasPositiveTokenUsage ? costUsd / (inputTokens + outputTokens) : undefined,
      description: costDescription,
    });
    const callId = await this.persistence.recordCall({
      taskId: input.taskId,
      role: input.role,
      model: input.modelId,
      inputTokens,
      outputTokens,
      costUsd: costUsd.toFixed(6),
      latencyMs: input.latencyMs,
      finishReason: input.event.finishReason,
      openrouterGenerationId:
        this.provider.kind === 'openrouter'
          ? (usage.generationId ?? input.event.response?.id)
          : null,
    });

    await this.recordForAudit(input, { callId, inputTokens, outputTokens });
  }

  /**
   * Keep what the model was asked and what it answered, when the owner has
   * turned capture on.
   *
   * Isolated in its own try/catch rather than riding on the caller's: this is
   * review telemetry, and it must never be able to mask a real metering failure
   * or, worse, make the workflow repeat paid model work. A row that does not
   * get written costs a line in a report; a throw here would cost a retry of
   * the provider call that already happened.
   */
  private async recordForAudit(
    input: MeterInput,
    usage: { callId?: string; inputTokens: number; outputTokens: number },
  ): Promise<void> {
    const { audit } = input;
    if (!audit) return;
    const mode = this.auditCapture;
    if (mode === 'off') return;

    try {
      const system = captureField(audit.system, mode);
      const promptInput = captureField(audit.input, mode);
      const output = captureField(audit.output, mode);
      await this.persistence.recordAudit({
        modelCallId: usage.callId,
        taskId: input.taskId,
        role: input.role,
        model: input.modelId,
        method: audit.method,
        capture: mode,
        systemPrompt: system.text ?? null,
        input: promptInput.text ?? null,
        output: output.text ?? null,
        truncated: system.truncated || promptInput.truncated || output.truncated,
        finishReason: input.event.finishReason,
        latencyMs: input.latencyMs,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    } catch (err) {
      console.error('model audit capture failed', err);
    }
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
    const { route, reservationId, maxOutputTokens, providerOptions, estimatedUsd } = prepared;

    const started = Date.now();
    try {
      return await withSpan('model.generate', { role, model: route.modelId }, async () => {
        const result = await generateText({
          model: route.model,
          ...(opts.messages
            ? this.cacheHintedArgs(opts.system, opts.messages)
            : { system: opts.system, ...promptArgs(opts) }),
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
          estimatedUsd,
          promptCostPerMTok: route.promptCostPerMTok,
          completionCostPerMTok: route.completionCostPerMTok,
          audit: {
            method: 'generate',
            system: opts.system,
            input: captureInput(opts),
            output: result.text,
          },
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
      await releaseReservation(this.persistence.costs, reservationId).catch(() => {});
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
    const { route, reservationId, maxOutputTokens, providerOptions, estimatedUsd } = prepared;

    const started = Date.now();
    let terminal: Promise<void> | undefined;
    const terminalOnce = (work: () => Promise<void>): Promise<void> => {
      if (!terminal) terminal = Promise.resolve().then(work);
      return terminal;
    };
    let result: ReturnType<typeof streamText>;
    try {
      result = streamText({
        model: route.model,
        // Cache-hint the system prefix on the messages path (the owner's chat
        // turn is the highest-frequency call in the system, and re-billed the
        // whole system prompt every turn without this). Mirrors stepOnce.
        ...(opts.messages
          ? this.cacheHintedArgs(opts.system, opts.messages)
          : { system: opts.system, ...promptArgs(opts) }),
        temperature: opts.temperature ?? (route.params.temperature as number | undefined),
        maxOutputTokens,
        providerOptions,
        abortSignal: modelCallSignal(opts.abortSignal),
        onFinish: async (event: FinishEventLike & { text?: string }) => {
          await terminalOnce(async () => {
            // AI SDK pauses stream finalization until this promise resolves.
            // Metering failures are contained so they cannot prevent reply persistence.
            await this.meterWithoutRepeatingProviderWork({
              taskId: opts.taskId,
              role,
              modelId: route.modelId,
              latencyMs: Date.now() - started,
              event,
              reservationId,
              estimatedUsd,
              promptCostPerMTok: route.promptCostPerMTok,
              completionCostPerMTok: route.completionCostPerMTok,
              audit: {
                method: 'stream',
                system: opts.system,
                input: captureInput(opts),
                output: event.text,
              },
            });
            if (event.finishReason === 'error') {
              const error = new Error('model stream finished with an error');
              if (opts.onError) {
                await opts.onError(error).catch((callbackError) => {
                  console.error('stream error callback failed', callbackError);
                });
              }
            } else {
              await opts.onComplete?.(event.text ?? '');
            }
          });
        },
        onError: async ({ error }: { error: unknown }) => {
          await terminalOnce(async () => {
            await releaseReservation(this.persistence.costs, reservationId).catch(() => {});
            if (opts.onError) {
              await opts.onError(error).catch((callbackError) => {
                console.error('stream error callback failed', callbackError);
              });
            }
          });
        },
        onAbort: async () => {
          await terminalOnce(async () => {
            const error = new Error('model stream aborted');
            await releaseReservation(this.persistence.costs, reservationId).catch(() => {});
            if (opts.onError) {
              await opts.onError(error).catch((callbackError) => {
                console.error('stream abort callback failed', callbackError);
              });
            }
          });
        },
      });
    } catch (err) {
      await releaseReservation(this.persistence.costs, reservationId).catch(() => {});
      throw err;
    }

    const narrowed = result as unknown as {
      text: PromiseLike<string>;
      toUIMessageStreamResponse: (options?: Record<string, unknown>) => Response;
      toUIMessageStream: (
        options?: Record<string, unknown>,
      ) => ReadableStream<unknown> & AsyncIterable<unknown>;
    };
    return {
      ok: true,
      modelId: route.modelId,
      degraded: route.degraded,
      text: narrowed.text,
      toUIMessageStreamResponse: (options) => narrowed.toUIMessageStreamResponse(options),
      toUIMessageStream: (options) => narrowed.toUIMessageStream(options),
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

  /**
   * Prompt-caching hints for the step loop. The system prompt is stable within
   * a task run and the transcript grows append-only, so two cache_control
   * breakpoints — after the system prompt and on the newest message — let each
   * step read the previous step's entire prefix from provider cache instead of
   * re-billing it. Anthropic models need the explicit breakpoints (via
   * OpenRouter); OpenAI-family models cache prefixes automatically and ignore
   * the hint.
   *
   * Returned as call arguments, not a bare messages array: the system prompt
   * has to ride inside `messages` (a system-role message is the only shape
   * that can carry a per-message cache_control providerOption), and AI SDK v7
   * rejects that with AI_InvalidPromptError unless `allowSystemInMessages` is
   * set. Bundling the flag with the messages makes it impossible for a call
   * site to take the hinted messages and forget the opt-in.
   */
  private cacheHintedArgs(
    system: string | undefined,
    messages: ModelMessage[],
  ): { messages: ModelMessage[]; allowSystemInMessages?: true; system?: string } {
    const hint = this.provider.cacheHint();
    if (!hint) return { ...(system ? { system } : {}), messages };
    const hinted = [...messages];
    const last = hinted[hinted.length - 1];
    if (last) {
      // A tool message may hold an entire batch of results. Message-level
      // cache options are copied onto every result by the provider, exceeding
      // its cache-breakpoint limit. Mark only the final content block.
      hinted[hinted.length - 1] = Array.isArray(last.content)
        ? ({
            ...last,
            content: last.content.map((part, index) =>
              index === last.content.length - 1
                ? {
                    ...part,
                    providerOptions: {
                      ...('providerOptions' in part ? part.providerOptions : {}),
                      ...hint,
                    },
                  }
                : part,
            ),
          } as ModelMessage)
        : ({ ...last, providerOptions: { ...last.providerOptions, ...hint } } as ModelMessage);
    }
    return {
      messages: system
        ? [{ role: 'system', content: system, providerOptions: hint } as ModelMessage, ...hinted]
        : hinted,
      allowSystemInMessages: true,
    };
  }

  private async stepOnce(
    role: Exclude<ModelRole, 'embed'>,
    opts: CallOptions & { tools: ToolSet; toolChoice?: StepToolChoice },
  ): Promise<StepCallOutcome> {
    const prepared = await this.prepareModelCall(role, opts);
    if (!prepared.ok) return prepared;
    const { route, reservationId, maxOutputTokens, providerOptions, estimatedUsd } = prepared;

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
          ...(opts.messages
            ? this.cacheHintedArgs(opts.system, encodeMessageToolNames(opts.messages))
            : { system: opts.system, ...promptArgs(opts) }),
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
          estimatedUsd,
          promptCostPerMTok: route.promptCostPerMTok,
          completionCostPerMTok: route.completionCostPerMTok,
          audit: {
            method: 'step',
            system: opts.system,
            input: captureInput(opts),
            // A step's answer is its prose *and* what it decided to call. A
            // record holding only the text would make every tool-calling turn
            // — most of the agent loop — look like it returned nothing.
            output: stepOutputForAudit(result.text, result.toolCalls),
          },
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
      await releaseReservation(this.persistence.costs, reservationId).catch(() => {});
      throw err;
    }
  }

  /** Structured output (planner, classifiers). Schema is a zod schema. */
  async object<T>(
    role: ModelRole,
    opts: CallOptions & { schema: ZodType<T> },
  ): Promise<ObjectOutcome<T>> {
    if (role === 'embed') throw new Error('object() cannot use the embed role');

    const runOnce = async (
      forceFallback: boolean,
      maxTokensOverride?: number,
    ): Promise<ObjectOutcome<T>> => {
      const prepared = await this.prepareModelCall(role, {
        ...opts,
        forceFallback: forceFallback || opts.forceFallback,
        ...(maxTokensOverride ? { maxOutputTokens: maxTokensOverride } : {}),
      });
      if (!prepared.ok) return prepared;
      const { route, reservationId, maxOutputTokens, providerOptions, estimatedUsd } = prepared;

      const started = Date.now();
      try {
        return await withSpan('model.object', { role, model: route.modelId }, async () => {
          const result = await generateObject({
            model: route.model,
            ...(opts.messages
              ? this.cacheHintedArgs(opts.system, opts.messages)
              : { system: opts.system, ...promptArgs(opts) }),
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
            estimatedUsd,
            promptCostPerMTok: route.promptCostPerMTok,
            completionCostPerMTok: route.completionCostPerMTok,
            audit: {
              method: 'object',
              system: opts.system,
              input: captureInput(opts),
              output: safeJson(result.object),
            },
          });
          return {
            ok: true as const,
            modelId: route.modelId,
            degraded: route.degraded,
            object: result.object as T,
            finishReason: result.finishReason,
          };
        });
      } catch (err) {
        const providerEvent = providerResultFromError(err);
        if (providerEvent) {
          await this.meterWithoutRepeatingProviderWork({
            taskId: opts.taskId,
            role,
            modelId: route.modelId,
            latencyMs: Date.now() - started,
            event: providerEvent,
            reservationId,
            estimatedUsd,
            promptCostPerMTok: route.promptCostPerMTok,
            completionCostPerMTok: route.completionCostPerMTok,
            audit: {
              method: 'object',
              system: opts.system,
              input: captureInput(opts),
            },
          });
        } else {
          await releaseReservation(this.persistence.costs, reservationId).catch(() => {});
        }
        throw err;
      }
    };

    const attempt = (forceFallback: boolean, maxTokensOverride?: number) =>
      this.withTimeoutRetry(opts, () => runOnce(forceFallback, maxTokensOverride));

    let outcome: ObjectOutcome<T>;
    try {
      outcome = await attempt(false);
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
        outcome = await attempt(true);
      } catch {
        // No usable fallback, or it also failed: surface the original
        // failure so the caller can skip this item.
        throw err;
      }
    }

    // Truncation guard: a schema-valid object can still be cut off at the token
    // limit (finishReason 'length') — the parse succeeds on a half-formed value.
    // Retry once on the fallback model with the largest allowed budget; if it
    // truncates again, fail typed so callers never render the fragment (the
    // "Are you" clarify bug — the plan role's 1024-token default was the cause).
    if (outcome.ok && outcome.finishReason === 'length') {
      const retryTokens = Math.max(opts.maxOutputTokens ?? 0, HARD_MAX_OUTPUT_TOKENS);
      let retried: ObjectOutcome<T> | undefined;
      try {
        retried = await attempt(true, retryTokens);
      } catch {
        throw new TruncatedObjectError(role);
      }
      if (retried.ok && retried.finishReason !== 'length') return retried;
      if (!retried.ok) return retried; // budget park/block — let the caller handle it
      throw new TruncatedObjectError(role);
    }
    return outcome;
  }

  /** Embeddings via the embed role. */
  async embed(
    values: string[],
    opts: { taskId?: string; abortSignal?: AbortSignal } = {},
  ): Promise<number[][]> {
    if (values.length > 0 && opts.taskId) await this.persistence.taskBudget(opts.taskId);
    const roleRow = await this.persistence.role('embed');
    if (!roleRow) throw new Error('no model_roles row for role: embed');
    if (values.length === 0) return [];
    if (values.length > 100) throw new Error('embedding batch exceeds 100 values');
    const modelRow = await this.persistence.model(roleRow.primaryModel);
    const promptCostPerMTok = Number(modelRow?.promptCostPerMTok);
    if (!modelRow || modelRow.promptCostPerMTok === null || !Number.isFinite(promptCostPerMTok)) {
      throw new Error(`embedding model ${roleRow.primaryModel} is missing a cost rate`);
    }
    this.provider.assertModelId(roleRow.primaryModel);
    const inputTokens = Math.max(
      1,
      Math.ceil(values.reduce((n, value) => n + value.length, 0) / 2),
    );
    const estimatedUsd = Math.max(
      0.000001,
      ((inputTokens * promptCostPerMTok) / 1_000_000) * ESTIMATE_SAFETY_FACTOR,
    );
    const reservation = await reserveCost(this.persistence.costs, {
      source: 'embedding',
      estimatedUsd,
      taskId: opts.taskId,
      description: `embed:${roleRow.primaryModel} preflight`,
    });
    if (!reservation.ok) throw new BudgetReservationError(reservation.reason, reservation.resumeAt);

    const started = Date.now();
    let providerSucceeded = false;
    let metered = false;
    const providerEvidence: EmbeddingProviderEvidence[] = [];
    let observation: ReturnType<typeof observeEmbeddingModel> | undefined;
    try {
      observation = observeEmbeddingModel(
        this.provider.textEmbeddingModel(roleRow.primaryModel),
        providerEvidence,
      );
      const { embeddings, usage, providerMetadata, responses } = await embedMany({
        model: observation.model,
        values,
        maxParallelCalls: 4,
        providerOptions: this.provider.embeddingOptions(),
        abortSignal: modelCallSignal(opts.abortSignal),
      });
      providerSucceeded = true;
      const event = {
        usage: usage ? { inputTokens: usage.tokens, outputTokens: 0 } : undefined,
        providerMetadata,
        responses,
      };
      const usageOverride = aggregateEmbeddingUsage(this.provider, providerEvidence);
      await this.meterWithoutRepeatingProviderWork({
        taskId: opts.taskId,
        role: 'embed',
        modelId: roleRow.primaryModel,
        latencyMs: Date.now() - started,
        event,
        reservationId: reservation.reservationId,
        estimatedUsd,
        usageOverride,
        promptCostPerMTok,
        completionCostPerMTok: 0,
      });
      metered = true;

      // Account for the successful provider call before inspecting its
      // result. A malformed response is still paid work, and validation must
      // never throw before metering can reconcile the reservation.
      const vectorList = Array.isArray(embeddings) ? embeddings : undefined;
      const invalid = vectorList?.findIndex((embedding) => {
        if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
          return true;
        }
        for (let index = 0; index < embedding.length; index += 1) {
          if (!(index in embedding) || !Number.isFinite(embedding[index])) return true;
        }
        return false;
      });
      if (!vectorList) {
        throw new Error('embedding provider returned a non-array result');
      }
      if (vectorList.length !== values.length) {
        throw new Error(
          `embedding provider returned ${vectorList.length} vectors for ${values.length} values`,
        );
      }
      if (invalid !== undefined && invalid !== -1) {
        throw new Error(`embedding provider returned an invalid vector at index ${invalid}`);
      }
      return vectorList as number[][];
    } catch (err) {
      observation?.stop();
      await observation?.waitForSettled();
      if (!providerSucceeded && providerEvidence.length > 0 && !metered) {
        await this.meterWithoutRepeatingProviderWork({
          taskId: opts.taskId,
          role: 'embed',
          modelId: roleRow.primaryModel,
          latencyMs: Date.now() - started,
          event: { responses: providerEvidence },
          reservationId: reservation.reservationId,
          estimatedUsd,
          usageOverride: aggregateEmbeddingUsage(this.provider, providerEvidence),
          promptCostPerMTok,
          completionCostPerMTok: 0,
        });
        metered = true;
      }
      if (!providerSucceeded && !metered) {
        await releaseReservation(this.persistence.costs, reservation.reservationId).catch(() => {});
      }
      throw err;
    }
  }
}
