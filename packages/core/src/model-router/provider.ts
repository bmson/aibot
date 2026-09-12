import { createVertex } from '@ai-sdk/google-vertex';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { EmbeddingModel, JSONValue, LanguageModel } from 'ai';

export type ProviderOptions = Record<string, Record<string, JSONValue>>;

export type ModelProviderKind = 'openrouter' | 'vertex';

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Provider-reported USD, when authoritative usage includes it. */
  costUsd?: number;
  generationId?: string;
}

export interface ModelProvider {
  readonly kind: ModelProviderKind;
  /** Reject model IDs belonging to another provider before constructing a request. */
  assertModelId(modelId: string): void;
  chat(modelId: string): LanguageModel;
  textEmbeddingModel(modelId: string): EmbeddingModel;
  optionsFor(input: { thinking: boolean }): ProviderOptions | undefined;
  /** Provider options applied to the embedding request. */
  embeddingOptions(): ProviderOptions | undefined;
  /** Provider-specific cache hints for the message boundary, if supported. */
  cacheHint(): Record<string, JSONValue> | undefined;
  normalizeUsage(event: unknown): ProviderUsage;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function providerMetadataRecord(
  root: Record<string, unknown> | undefined,
  finalStep: Record<string, unknown> | undefined,
  keys: string[],
): Record<string, unknown> | undefined {
  for (const metadata of [root, finalStep]) {
    for (const key of keys) {
      const value = record(metadata?.[key]);
      const usage = record(value?.usage);
      if (usage && Object.keys(usage).length > 0) return usage;
    }
  }
  return undefined;
}

function finiteNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 2_147_483_647
    ? value
    : undefined;
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Normalize OpenRouter's provider metadata without making absent cost look free. */
export function normalizeOpenRouterUsage(event: unknown): ProviderUsage {
  const root = record(event);
  const usage = record(root?.usage);
  const finalStep = record(root?.finalStep);
  const providerMetadata = providerMetadataRecord(
    record(root?.providerMetadata),
    record(finalStep?.providerMetadata),
    ['openrouter'],
  );
  const response = record(root?.response);
  return {
    inputTokens: finiteNonnegativeInteger(usage?.inputTokens),
    outputTokens: finiteNonnegativeInteger(usage?.outputTokens),
    costUsd: finiteNonnegative(providerMetadata?.cost),
    generationId: nonemptyString(response?.id),
  };
}

/** Vertex reports token usage through the common AI SDK result shape. */
export function normalizeVertexUsage(event: unknown): ProviderUsage {
  const root = record(event);
  const usage = record(root?.usage);
  const finalStep = record(root?.finalStep);
  const providerMetadata = providerMetadataRecord(
    record(root?.providerMetadata),
    record(finalStep?.providerMetadata),
    ['vertex', 'googleVertex', 'google-vertex'],
  );
  const response = record(root?.response);
  return {
    inputTokens: finiteNonnegativeInteger(usage?.inputTokens),
    outputTokens: finiteNonnegativeInteger(usage?.outputTokens),
    costUsd: finiteNonnegative(providerMetadata?.costUsd ?? providerMetadata?.cost),
    generationId: nonemptyString(response?.id),
  };
}

function assertOpenRouterModelId(modelId: string): void {
  // OpenRouter legitimately uses IDs such as google/gemini-*. Reserve the
  // explicit vertex: / vertex/ namespace for a future Vertex adapter.
  if (
    !modelId ||
    /^(?:vertex(?:[/:]|$)|google:|projects\/[^/]+\/locations\/[^/]+\/publishers\/[^/]+\/models\/)/i.test(
      modelId,
    )
  ) {
    throw new Error(`OpenRouter provider cannot serve model identity: ${modelId || '<empty>'}`);
  }
}

export function createOpenRouterModelProvider(apiKey: string): ModelProvider {
  const provider = createOpenRouter({ apiKey });
  return {
    kind: 'openrouter',
    assertModelId: assertOpenRouterModelId,
    chat(modelId) {
      assertOpenRouterModelId(modelId);
      return provider.chat(modelId, { provider: { require_parameters: true } });
    },
    textEmbeddingModel(modelId) {
      assertOpenRouterModelId(modelId);
      return provider.textEmbeddingModel(modelId);
    },
    optionsFor({ thinking }) {
      return thinking ? { openrouter: { reasoning: { max_tokens: 4_096 } } } : undefined;
    },
    embeddingOptions: () => undefined,
    cacheHint: () => ({ openrouter: { cacheControl: { type: 'ephemeral' } } }),
    normalizeUsage: normalizeOpenRouterUsage,
  };
}

export interface VertexModelProviderOptions {
  /** Explicitly selected Google Cloud project used for ADC-backed requests. */
  project: string;
  /** Explicit Vertex region, for example `us-central1`. */
  location: string;
}

function vertexModelId(modelId: string): string {
  const match = /^vertex(?::|\/)(.+)$/i.exec(modelId);
  if (!match?.[1]) {
    throw new Error(
      `Vertex provider requires a vertex-qualified model identity: ${modelId || '<empty>'}`,
    );
  }
  const id = match[1];
  // Vertex model IDs are bare slugs. Requiring this shape prevents an
  // OpenRouter/provider namespace, URL, or resource path from being sent to
  // Vertex while leaving model availability to the configured project.
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(id)) {
    throw new Error(`Vertex provider requires a bare model identity: ${modelId}`);
  }
  return id;
}

function assertVertexModelId(modelId: string): void {
  vertexModelId(modelId);
}

/**
 * Construct the opt-in ADC-backed Vertex adapter. This does not make a
 * request during construction; the AI SDK obtains credentials only when a
 * model call is executed. No API-key/Express mode is configured here.
 */
export function createVertexModelProvider(options: VertexModelProviderOptions): ModelProvider {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.project)) {
    throw new Error(`Vertex provider requires a valid Google Cloud project ID: ${options.project}`);
  }
  if (!/^(?:global|[a-z][a-z0-9-]*[0-9])$/.test(options.location)) {
    throw new Error(`Vertex provider requires a valid Vertex location: ${options.location}`);
  }
  // An explicit empty string is intentional: the SDK otherwise falls back to
  // GOOGLE_VERTEX_API_KEY when present and silently selects Express mode.
  // Empty disables that fallback while leaving ADC/service identity active.
  const provider = createVertex({
    project: options.project,
    location: options.location,
    apiKey: '',
  });
  return {
    kind: 'vertex',
    assertModelId: assertVertexModelId,
    chat(modelId) {
      return provider.languageModel(vertexModelId(modelId));
    },
    textEmbeddingModel(modelId) {
      return provider.embeddingModel(vertexModelId(modelId));
    },
    optionsFor({ thinking }) {
      return thinking ? { vertex: { thinkingConfig: { thinkingBudget: 4_096 } } } : undefined;
    },
    embeddingOptions: () => ({ vertex: { outputDimensionality: 1_536 } }),
    cacheHint: () => undefined,
    normalizeUsage: normalizeVertexUsage,
  };
}
