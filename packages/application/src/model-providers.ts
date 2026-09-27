import type { Config } from '@assistant/config';
import {
  connectionIdForModel,
  GATEWAY_CONNECTION_ID,
  MODEL_CONNECTION_KINDS,
  type ModelConnectionKind,
} from '@assistant/core/model-router';
import {
  isRoutableModel,
  MODEL_ROLE_NAMES,
  type ModelCatalogRepository,
  type ModelConnectionRepository,
  type Records,
} from '@assistant/persistence';

/**
 * Settings → AI providers: which model providers are connected, and which of
 * their models the assistant uses. Driver-neutral; the web and mobile
 * transports bind it to PostgreSQL or Firestore repositories.
 *
 * API keys enter through `saveModelConnection`, are sealed immediately, and
 * never leave again: every view projects them to `hasApiKey`.
 */

export type ProviderConfig = Pick<
  Config,
  'LLM_PROVIDER' | 'OPENROUTER_API_KEY' | 'VERTEX_PROJECT' | 'VERTEX_LOCATION'
>;

export interface ModelProviderPorts {
  connections: ModelConnectionRepository;
  catalog: ModelCatalogRepository;
  config: ProviderConfig;
  /** Seal an API key for storage (MCP_ENC_KEY). */
  seal: (plaintext: string) => string;
  /** Open a sealed key, only to test the connection it belongs to. */
  open: (sealed: string) => string;
  fetch?: typeof fetch;
}

export const PROVIDER_KIND_LABELS: Record<ModelConnectionKind, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  vertex: 'Google Vertex AI',
  openai_compatible: 'OpenAI-compatible',
};

/** Roles the "Main model" drives: planning, tool use, and replies the owner reads. */
export const MAIN_MODEL_ROLES = ['plan', 'reason', 'draft'] as const;
/** Roles the "Fast model" drives: high-volume background classification and rewriting. */
export const FAST_MODEL_ROLES = ['classify', 'extract', 'rewrite', 'batch'] as const;

export interface ModelConnectionView {
  id: string;
  kind: ModelConnectionKind;
  label: string;
  baseUrl: string | null;
  vertexProject: string | null;
  vertexLocation: string | null;
  hasApiKey: boolean;
  enabled: boolean;
  /** `environment`: not saved in the app; the deployment's settings stand in for it. */
  source: 'saved' | 'environment';
  lastTestedAt: Date | null;
  lastError: string | null;
}

export interface CatalogModelView {
  id: string;
  label: string;
  connectionId: string;
  enabled: boolean;
  routable: boolean;
  embedding: boolean;
  promptCostPerMTok: string | null;
  completionCostPerMTok: string | null;
}

export interface ModelProviderSettingsView {
  connections: ModelConnectionView[];
  models: CatalogModelView[];
  roles: Array<{ role: string; primaryModel: string; fallbackModel: string }>;
  mainModel: string | null;
  fastModel: string | null;
}

function isKind(value: string): value is ModelConnectionKind {
  return (MODEL_CONNECTION_KINDS as readonly string[]).includes(value);
}

function view(row: Records['modelConnections']): ModelConnectionView {
  return {
    id: row.id,
    kind: isKind(row.kind) ? row.kind : 'openai_compatible',
    label: row.label,
    baseUrl: row.baseUrl,
    vertexProject: row.vertexProject,
    vertexLocation: row.vertexLocation,
    hasApiKey: row.apiKeyEncrypted !== null,
    enabled: row.enabled,
    source: 'saved',
    lastTestedAt: row.lastTestedAt,
    lastError: row.lastError,
  };
}

/** The deployment's built-in connections the owner has not saved (yet). */
function environmentConnections(
  config: ProviderConfig,
  saved: ReadonlySet<string>,
): ModelConnectionView[] {
  const stand = (
    kind: 'openrouter' | 'vertex',
    extra: Partial<ModelConnectionView>,
  ): ModelConnectionView => ({
    id: kind,
    kind,
    label: PROVIDER_KIND_LABELS[kind],
    baseUrl: null,
    vertexProject: null,
    vertexLocation: null,
    hasApiKey: false,
    enabled: true,
    source: 'environment',
    lastTestedAt: null,
    lastError: null,
    ...extra,
  });
  const result: ModelConnectionView[] = [];
  if (!saved.has('openrouter') && config.LLM_PROVIDER !== 'vertex' && config.OPENROUTER_API_KEY)
    result.push(stand('openrouter', { hasApiKey: true }));
  if (!saved.has('vertex') && config.VERTEX_PROJECT && config.VERTEX_LOCATION)
    result.push(
      stand('vertex', {
        vertexProject: config.VERTEX_PROJECT,
        vertexLocation: config.VERTEX_LOCATION,
      }),
    );
  return result;
}

export async function getModelProviderSettings(
  ports: ModelProviderPorts,
): Promise<ModelProviderSettingsView> {
  const [rows, models, roles] = await Promise.all([
    ports.connections.list(),
    ports.catalog.listModels(),
    ports.catalog.listRoles(),
  ]);
  const connections = [
    ...rows.map(view),
    ...environmentConnections(ports.config, new Set(rows.map((row) => row.id))),
  ].sort((left, right) => left.label.localeCompare(right.label));
  const primary = (role: string) => roles.find((row) => row.role === role)?.primaryModel ?? null;
  return {
    connections,
    models: models.map((model) => ({
      id: model.id,
      label: model.label,
      connectionId: connectionIdForModel(model.id),
      enabled: model.enabled,
      routable: isRoutableModel(model),
      embedding: (model.capabilities as { embedding?: boolean } | null)?.embedding === true,
      promptCostPerMTok: model.promptCostPerMTok,
      completionCostPerMTok: model.completionCostPerMTok,
    })),
    roles: roles.map(({ role, primaryModel, fallbackModel }) => ({
      role,
      primaryModel,
      fallbackModel,
    })),
    mainModel: primary('reason'),
    fastModel: primary('classify'),
  };
}

export interface SaveModelConnectionInput {
  kind: string;
  /** Required for OpenAI-compatible gateways; built-in kinds use their kind as the id. */
  id?: string;
  label?: string;
  /** Omit or leave empty to keep the stored key. */
  apiKey?: string;
  baseUrl?: string;
  vertexProject?: string;
  vertexLocation?: string;
}

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** Whitespace or a control character, which no key or model name contains. */
function hasSpaceOrControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || /\s/u.test(character)) return true;
  }
  return false;
}

/** Hosts a gateway URL may never name: cloud metadata endpoints. */
function forbiddenGatewayHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'metadata.google.internal' ||
    host === 'metadata' ||
    host.startsWith('169.254.') ||
    host === 'fd00:ec2::254'
  );
}

function cleanBaseUrl(value: string | undefined): string | null {
  try {
    const url = new URL((value ?? '').trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    if (url.search || url.hash || forbiddenGatewayHost(url.hostname)) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export async function saveModelConnection(
  ports: ModelProviderPorts,
  input: SaveModelConnectionInput,
): Promise<Result<{ id: string }>> {
  if (!isKind(input.kind)) return { ok: false, error: 'Choose a provider type.' };
  const kind = input.kind;
  const id = kind === 'openai_compatible' ? (input.id ?? '').trim().toLowerCase() : kind;
  if (kind === 'openai_compatible') {
    if (!GATEWAY_CONNECTION_ID.test(id) || isKind(id))
      return {
        ok: false,
        error: 'Give the gateway a short id: lowercase letters, digits and dashes (e.g. groq).',
      };
  }
  const label =
    (input.label ?? '').trim().replace(/\s+/g, ' ').slice(0, 60) || PROVIDER_KIND_LABELS[kind];
  const apiKey = (input.apiKey ?? '').trim();
  if (apiKey && (apiKey.length > 4_096 || hasSpaceOrControl(apiKey)))
    return { ok: false, error: 'That API key has spaces or is too long.' };

  const existing = (await ports.connections.list()).find((row) => row.id === id);
  if (existing && existing.kind !== kind)
    return { ok: false, error: `The id "${id}" is already used by another connection.` };

  let baseUrl: string | null = null;
  let vertexProject: string | null = null;
  let vertexLocation: string | null = null;
  if (kind === 'openai_compatible') {
    baseUrl = cleanBaseUrl(input.baseUrl);
    if (!baseUrl)
      return {
        ok: false,
        error: 'Enter the gateway’s base URL, e.g. https://api.groq.com/openai/v1.',
      };
  }
  if (kind === 'vertex') {
    vertexProject = (input.vertexProject ?? '').trim() || null;
    vertexLocation = (input.vertexLocation ?? '').trim() || null;
    if (vertexProject && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(vertexProject))
      return { ok: false, error: 'That is not a Google Cloud project id.' };
    if (vertexLocation && !/^(?:global|[a-z][a-z0-9-]*[0-9])$/.test(vertexLocation))
      return { ok: false, error: 'That is not a Vertex location (e.g. us-central1 or global).' };
    if (
      !(vertexProject ?? ports.config.VERTEX_PROJECT) ||
      !(vertexLocation ?? ports.config.VERTEX_LOCATION)
    )
      return { ok: false, error: 'Vertex needs a Google Cloud project and location.' };
  }
  const needsKey = kind === 'openai' || (kind === 'openrouter' && !ports.config.OPENROUTER_API_KEY);
  if (needsKey && !apiKey && !existing?.apiKeyEncrypted)
    return { ok: false, error: `Paste your ${PROVIDER_KIND_LABELS[kind]} API key.` };

  let apiKeyEncrypted: string | undefined;
  try {
    apiKeyEncrypted = apiKey ? ports.seal(apiKey) : undefined;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to protect the key.',
    };
  }
  await ports.connections.upsert({
    id,
    kind,
    label,
    baseUrl,
    vertexProject,
    vertexLocation,
    enabled: existing?.enabled ?? true,
    ...(apiKeyEncrypted !== undefined ? { apiKeyEncrypted } : {}),
  });
  return { ok: true, id };
}

/** Roles whose primary or fallback model this connection serves. */
async function rolesUsing(ports: ModelProviderPorts, connectionId: string): Promise<string[]> {
  const roles = await ports.catalog.listRoles();
  return roles
    .filter(
      (row) =>
        connectionIdForModel(row.primaryModel) === connectionId ||
        connectionIdForModel(row.fallbackModel) === connectionId,
    )
    .map((row) => row.role);
}

function inUseError(label: string, roles: string[]): string {
  return `${label} is still used by ${roles.join(', ')}. Pick other models for ${
    roles.length === 1 ? 'that role' : 'those roles'
  } first.`;
}

async function connectionView(
  ports: ModelProviderPorts,
  id: string,
): Promise<{ row: Records['modelConnections'] | null; view: ModelConnectionView | null }> {
  const rows = await ports.connections.list();
  const row = rows.find((candidate) => candidate.id === id) ?? null;
  if (row) return { row, view: view(row) };
  const standIn = environmentConnections(ports.config, new Set()).find((c) => c.id === id);
  return { row: null, view: standIn ?? null };
}

export async function setModelConnectionEnabled(
  ports: ModelProviderPorts,
  id: string,
  enabled: boolean,
): Promise<Result> {
  const { row, view: current } = await connectionView(ports, id);
  if (!current) return { ok: false, error: 'That connection no longer exists.' };
  if (!enabled) {
    const roles = await rolesUsing(ports, id);
    if (roles.length) return { ok: false, error: inUseError(current.label, roles) };
  }
  if (row) {
    await ports.connections.setEnabled(id, enabled);
  } else {
    // Turning off the environment's stand-in saves it, keyless, as off; the
    // deployment key is used again if it is turned back on.
    await ports.connections.upsert({
      id,
      kind: current.kind,
      label: current.label,
      baseUrl: null,
      vertexProject: null,
      vertexLocation: null,
      enabled,
      apiKeyEncrypted: null,
    });
  }
  return { ok: true };
}

export async function removeModelConnection(
  ports: ModelProviderPorts,
  id: string,
): Promise<Result> {
  const { row } = await connectionView(ports, id);
  if (!row) return { ok: false, error: 'Only connections saved in the app can be removed.' };
  const roles = await rolesUsing(ports, id);
  if (roles.length) return { ok: false, error: inUseError(row.label, roles) };
  await ports.connections.remove(id);
  return { ok: true };
}

export interface ProviderModelListing {
  /** The provider's own model name (without our namespace). */
  model: string;
  label: string;
  /** USD per million tokens, when the provider publishes it (OpenRouter does). */
  promptCostPerMTok?: string;
  completionCostPerMTok?: string;
  thinking?: boolean;
}

function perMillion(value: unknown): string | undefined {
  const perToken = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  if (!Number.isFinite(perToken) || perToken < 0) return undefined;
  return (perToken * 1_000_000).toFixed(4);
}

async function fetchJson(
  ports: ModelProviderPorts,
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  const doFetch = ports.fetch ?? fetch;
  try {
    const response = await doFetch(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 401 || response.status === 403)
      return { ok: false, error: 'The provider rejected the API key.' };
    if (!response.ok) return { ok: false, error: `The provider answered HTTP ${response.status}.` };
    return { ok: true, body: await response.json() };
  } catch (error) {
    const timeout = error instanceof Error && error.name === 'TimeoutError';
    return {
      ok: false,
      error: timeout
        ? 'The provider did not answer within 8 seconds.'
        : 'Could not reach the provider.',
    };
  }
}

/**
 * Check a connection's credentials by listing its models — a free, read-only
 * request on every key-based provider. Vertex uses the service's own Google
 * credentials, which the first real call verifies; listing is not offered.
 */
export async function testModelConnection(
  ports: ModelProviderPorts,
  id: string,
): Promise<Result<{ models: ProviderModelListing[] }>> {
  const { row, view: current } = await connectionView(ports, id);
  if (!current) return { ok: false, error: 'That connection no longer exists.' };
  let key = '';
  try {
    key = row?.apiKeyEncrypted ? ports.open(row.apiKeyEncrypted) : '';
  } catch {
    return { ok: false, error: 'The saved key can no longer be read; paste it again.' };
  }
  const auth = (value: string): Record<string, string> =>
    value ? { authorization: `Bearer ${value}` } : {};

  let result: Awaited<ReturnType<typeof fetchJson>>;
  let models: ProviderModelListing[] = [];
  switch (current.kind) {
    case 'vertex':
      result = { ok: true, body: null };
      break;
    case 'openrouter':
      result = await fetchJson(
        ports,
        'https://openrouter.ai/api/v1/models',
        auth(key || ports.config.OPENROUTER_API_KEY),
      );
      if (result.ok) {
        // The catalog is public; confirm the key itself separately.
        const keyCheck = await fetchJson(
          ports,
          'https://openrouter.ai/api/v1/key',
          auth(key || ports.config.OPENROUTER_API_KEY),
        );
        if (!keyCheck.ok) result = keyCheck;
      }
      break;
    case 'openai':
      result = await fetchJson(ports, 'https://api.openai.com/v1/models', auth(key));
      break;
    default:
      result = await fetchJson(ports, `${current.baseUrl}/models`, auth(key));
  }
  if (result.ok && result.body) {
    const data = (result.body as { data?: unknown }).data;
    models = (Array.isArray(data) ? data : [])
      .flatMap((entry): ProviderModelListing[] => {
        const item = entry as {
          id?: unknown;
          name?: unknown;
          pricing?: { prompt?: unknown; completion?: unknown };
          supported_parameters?: unknown;
        };
        if (typeof item.id !== 'string' || !item.id || item.id.length > 200) return [];
        return [
          {
            model: item.id,
            label: typeof item.name === 'string' && item.name ? item.name.slice(0, 120) : item.id,
            promptCostPerMTok: perMillion(item.pricing?.prompt),
            completionCostPerMTok: perMillion(item.pricing?.completion),
            thinking: Array.isArray(item.supported_parameters)
              ? item.supported_parameters.includes('reasoning')
              : undefined,
          },
        ];
      })
      .sort((left, right) => left.model.localeCompare(right.model))
      .slice(0, 1_000);
  }
  if (row) await ports.connections.recordTest(id, result.ok ? { ok: true } : result);
  return result.ok ? { ok: true, models } : result;
}

/** The catalog identity for a provider's own model name on a connection. */
export function catalogModelId(
  connection: { id: string; kind: ModelConnectionKind },
  model: string,
) {
  switch (connection.kind) {
    case 'openrouter':
      return model;
    case 'openai':
      return `openai:${model}`;
    case 'vertex':
      return `vertex:${model}`;
    default:
      return `gw:${connection.id}:${model}`;
  }
}

function cleanPrice(value: string | number | undefined): string | null {
  const text = typeof value === 'number' ? String(value) : (value ?? '').trim();
  if (!/^\d{1,4}(?:\.\d{1,4})?$/.test(text)) return null;
  return Number(text).toFixed(4);
}

export interface AddCatalogModelInput {
  connectionId: string;
  model: string;
  label?: string;
  promptCostPerMTok: string | number;
  completionCostPerMTok: string | number;
  thinking?: boolean;
}

/**
 * Add (or re-price) a provider model in the catalog. Prices are required: the
 * router refuses to call a model it cannot budget, so an unpriced model could
 * never be selected anyway.
 */
export async function addCatalogModel(
  ports: ModelProviderPorts,
  input: AddCatalogModelInput,
): Promise<Result<{ id: string }>> {
  const { view: connection } = await connectionView(ports, input.connectionId);
  if (!connection) return { ok: false, error: 'Connect that provider first.' };
  const model = input.model.trim();
  if (!model || model.length > 200 || hasSpaceOrControl(model))
    return { ok: false, error: 'Enter the model name exactly as the provider spells it.' };
  if (connection.kind === 'openai' && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(model))
    return { ok: false, error: 'OpenAI model names look like gpt-5.1 or gpt-realtime.' };
  if (connection.kind === 'vertex' && !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(model))
    return { ok: false, error: 'Vertex model names look like gemini-2.5-flash.' };
  const prompt = cleanPrice(input.promptCostPerMTok);
  const completion = cleanPrice(input.completionCostPerMTok);
  if (prompt === null || completion === null)
    return {
      ok: false,
      error:
        'Enter the input and output price in USD per million tokens (see the provider’s pricing page).',
    };
  const id = catalogModelId(connection, model);
  const existing = (await ports.catalog.listModels()).find((row) => row.id === id);
  const capabilities = {
    ...((existing?.capabilities as Record<string, unknown> | null) ?? {}),
    tools: true,
    json: true,
    streaming: true,
    ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
  };
  await ports.catalog.upsertModel({
    id,
    label: (input.label ?? '').trim().slice(0, 120) || existing?.label || model,
    capabilities,
    promptCostPerMTok: prompt,
    completionCostPerMTok: completion,
    latencyClass: existing?.latencyClass ?? 'medium',
    enabled: true,
  });
  return { ok: true, id };
}

/**
 * Point the assistant at a main and a fast model in one save. Each role keeps
 * its current fallback while that fallback is still usable, so switching
 * providers keeps a second provider behind the first; otherwise the fallback
 * becomes the new primary.
 */
export async function chooseTextModels(
  ports: ModelProviderPorts,
  input: { mainModel: string; fastModel: string },
): Promise<Result> {
  const [models, roles, rows] = await Promise.all([
    ports.catalog.listModels(),
    ports.catalog.listRoles(),
    ports.connections.list(),
  ]);
  const byId = new Map(models.map((model) => [model.id, model]));
  const connectionOff = (modelId: string) =>
    rows.some((row) => row.id === connectionIdForModel(modelId) && !row.enabled);
  for (const chosen of [input.mainModel, input.fastModel]) {
    const model = byId.get(chosen);
    if (!isRoutableModel(model) || (model?.capabilities as { embedding?: boolean })?.embedding)
      return { ok: false, error: `${chosen} is not an enabled, priced chat model.` };
    if (connectionOff(chosen))
      return { ok: false, error: `Turn on the connection for ${chosen} first.` };
  }
  const assignments = [
    ...MAIN_MODEL_ROLES.map((role) => ({ role, primaryModel: input.mainModel })),
    ...FAST_MODEL_ROLES.map((role) => ({ role, primaryModel: input.fastModel })),
  ].map(({ role, primaryModel }) => {
    const current = roles.find((row) => row.role === role)?.fallbackModel;
    const keep = current && isRoutableModel(byId.get(current)) && !connectionOff(current);
    return { role, primaryModel, fallbackModel: keep ? current : primaryModel };
  });
  if (!assignments.every(({ role }) => (MODEL_ROLE_NAMES as readonly string[]).includes(role)))
    return { ok: false, error: 'Unknown model role.' };
  await ports.catalog.assignRoles(assignments);
  return { ok: true };
}
