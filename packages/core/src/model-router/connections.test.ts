import type { Records } from '@assistant/persistence';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionIdForModel, createConnectedModelProviders } from './connections.js';
import { createOpenRouterModelProvider, gatewayModelId } from './provider.js';

const stubs = vi.hoisted(() => ({
  createOpenRouter: vi.fn(),
  createOpenAI: vi.fn(),
  createOpenAICompatible: vi.fn(),
  createVertex: vi.fn(),
}));

vi.mock('@openrouter/ai-sdk-provider', () => ({ createOpenRouter: stubs.createOpenRouter }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: stubs.createOpenAI }));
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: stubs.createOpenAICompatible,
}));
vi.mock('@ai-sdk/google-vertex', () => ({ createVertex: stubs.createVertex }));

const env = {
  LLM_PROVIDER: 'openrouter' as const,
  OPENROUTER_API_KEY: 'env-openrouter-key',
  VERTEX_PROJECT: '',
  VERTEX_LOCATION: '',
};

function connection(
  overrides: Partial<Records['modelConnections']> &
    Pick<Records['modelConnections'], 'id' | 'kind'>,
): Records['modelConnections'] {
  return {
    label: overrides.id,
    baseUrl: null,
    apiKeyEncrypted: 'sealed',
    vertexProject: null,
    vertexLocation: null,
    enabled: true,
    lastTestedAt: null,
    lastError: null,
    createdAt: new Date(0),
    updatedAt: new Date(1_000),
    ...overrides,
  };
}

const decrypt = (payload: string) => `plain:${payload}`;

beforeEach(() => {
  vi.clearAllMocks();
  stubs.createOpenRouter.mockImplementation(() => ({ chat: vi.fn(), textEmbeddingModel: vi.fn() }));
  stubs.createOpenAI.mockImplementation(() => ({
    chat: vi.fn((id: string) => ({ openaiModel: id })),
    embeddingModel: vi.fn(),
  }));
  stubs.createOpenAICompatible.mockImplementation(() => ({
    chatModel: vi.fn((id: string) => ({ gatewayModel: id })),
    embeddingModel: vi.fn(),
  }));
  stubs.createVertex.mockImplementation(() => ({
    languageModel: vi.fn(),
    embeddingModel: vi.fn(),
  }));
});

describe('model identity namespaces', () => {
  it('maps every identity to exactly one connection', () => {
    expect(connectionIdForModel('minimax/minimax-m2.7')).toBe('openrouter');
    expect(connectionIdForModel('openai/gpt-oss-120b')).toBe('openrouter');
    expect(connectionIdForModel('openai:gpt-5.1')).toBe('openai');
    expect(connectionIdForModel('vertex:gemini-2.5-flash')).toBe('vertex');
    expect(connectionIdForModel('vertex/gemini-2.5-flash')).toBe('vertex');
    expect(connectionIdForModel('gw:groq:llama-3.3-70b')).toBe('groq');
  });

  it('keeps direct-adapter identities away from OpenRouter', () => {
    const openrouter = createOpenRouterModelProvider('unused');
    expect(() => openrouter.assertModelId('openai/gpt-oss-120b')).not.toThrow();
    expect(() => openrouter.assertModelId('openai:gpt-5.1')).toThrow('identity');
    expect(() => openrouter.assertModelId('gw:groq:llama')).toThrow('identity');
  });

  it('reads the upstream name out of a gateway identity, including slashes', () => {
    expect(gatewayModelId('together', 'gw:together:meta-llama/Llama-4')).toBe('meta-llama/Llama-4');
    expect(() => gatewayModelId('together', 'gw:groq:llama')).toThrow('cannot serve');
    expect(() => gatewayModelId('together', 'gw:together:')).toThrow('cannot serve');
  });
});

describe('connected model providers', () => {
  it('falls back to the environment until the owner saves a connection', async () => {
    const providers = createConnectedModelProviders(env, async () => [], { decrypt });
    await providers.refresh();
    expect(providers.resolve('minimax/minimax-m2.7').kind).toBe('openrouter');
    expect(stubs.createOpenRouter).toHaveBeenCalledWith({ apiKey: 'env-openrouter-key' });
    expect(() => providers.resolve('openai:gpt-5.1')).toThrow('No model connection serves');
  });

  it('gives a Vertex installation no implicit OpenRouter connection', async () => {
    stubs.createVertex.mockReturnValue({ languageModel: vi.fn(), embeddingModel: vi.fn() });
    const providers = createConnectedModelProviders(
      {
        ...env,
        LLM_PROVIDER: 'vertex',
        VERTEX_PROJECT: 'bmson-assistant',
        VERTEX_LOCATION: 'global',
      },
      async () => [],
      { decrypt },
    );
    await providers.refresh();
    expect(providers.resolve('vertex:gemini-2.5-flash').kind).toBe('vertex');
    expect(() => providers.resolve('minimax/minimax-m2.7')).toThrow('No model connection serves');
  });

  it('serves each model from its own saved connection with the unsealed key', async () => {
    const providers = createConnectedModelProviders(
      env,
      async () => [
        connection({ id: 'openrouter', kind: 'openrouter', apiKeyEncrypted: 'or' }),
        connection({ id: 'openai', kind: 'openai', apiKeyEncrypted: 'oa' }),
        connection({
          id: 'groq',
          kind: 'openai_compatible',
          baseUrl: 'https://api.groq.com/openai/v1/',
          apiKeyEncrypted: 'gq',
        }),
      ],
      { decrypt },
    );
    await providers.refresh();

    expect(providers.resolve('minimax/minimax-m2.7').kind).toBe('openrouter');
    expect(stubs.createOpenRouter).toHaveBeenCalledWith({ apiKey: 'plain:or' });

    const openai = providers.resolve('openai:gpt-5.1');
    expect(openai.kind).toBe('openai');
    expect(stubs.createOpenAI).toHaveBeenCalledWith({ apiKey: 'plain:oa' });
    expect(openai.chat('openai:gpt-5.1')).toEqual({ openaiModel: 'gpt-5.1' });

    const groq = providers.resolve('gw:groq:llama-3.3-70b');
    expect(groq.kind).toBe('openai_compatible');
    expect(stubs.createOpenAICompatible).toHaveBeenCalledWith({
      name: 'groq',
      baseURL: 'https://api.groq.com/openai/v1',
      apiKey: 'plain:gq',
      includeUsage: true,
    });
    expect(groq.chat('gw:groq:llama-3.3-70b')).toEqual({ gatewayModel: 'llama-3.3-70b' });
  });

  it('refuses a model whose connection the owner turned off, even with an env key', async () => {
    const providers = createConnectedModelProviders(
      env,
      async () => [connection({ id: 'openrouter', kind: 'openrouter', enabled: false })],
      { decrypt },
    );
    await providers.refresh();
    expect(() => providers.resolve('minimax/minimax-m2.7')).toThrow('turned off');
  });

  it('reuses an adapter until its connection changes, and re-reads only after the TTL', async () => {
    let clock = 0;
    let rows = [connection({ id: 'openai', kind: 'openai', updatedAt: new Date(1) })];
    const load = vi.fn(async () => rows);
    const providers = createConnectedModelProviders(env, load, {
      decrypt,
      ttlMs: 1_000,
      now: () => clock,
    });

    await providers.refresh();
    const first = providers.resolve('openai:gpt-5.1');
    await providers.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    expect(providers.resolve('openai:gpt-5.1')).toBe(first);

    rows = [connection({ id: 'openai', kind: 'openai', updatedAt: new Date(2) })];
    clock = 1_000;
    await providers.refresh();
    expect(load).toHaveBeenCalledTimes(2);
    expect(providers.resolve('openai:gpt-5.1')).not.toBe(first);
  });

  it('keeps the last good list when a re-read fails', async () => {
    let clock = 0;
    const load = vi
      .fn<() => Promise<Records['modelConnections'][]>>()
      .mockResolvedValueOnce([connection({ id: 'openai', kind: 'openai' })])
      .mockRejectedValueOnce(new Error('firestore unavailable'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const providers = createConnectedModelProviders(env, load, {
      decrypt,
      ttlMs: 1_000,
      now: () => clock,
    });
    await providers.refresh();
    clock = 5_000;
    await providers.refresh();
    expect(providers.resolve('openai:gpt-5.1').kind).toBe('openai');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('rejects a gateway base URL carrying credentials', async () => {
    const providers = createConnectedModelProviders(
      env,
      async () => [
        connection({
          id: 'proxy',
          kind: 'openai_compatible',
          baseUrl: 'https://user:pass@proxy.example/v1',
        }),
      ],
      { decrypt },
    );
    await providers.refresh();
    expect(() => providers.resolve('gw:proxy:model')).toThrow('without embedded credentials');
  });
});
