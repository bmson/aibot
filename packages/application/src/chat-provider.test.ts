import { loadConfig, resetConfigForTest } from '@assistant/config';
import type { ModelRouter } from '@assistant/core/model-router';
import type { Db } from '@assistant/db';
import { afterEach, describe, expect, it } from 'vitest';
import { handleChatTurn } from './chat-turn.js';

// Invalid request bodies stop immediately after configuration validation, before DB/model work.
const request = () =>
  new Request('https://assistant.example/api/chat', { method: 'POST', body: '{' });
const unused = { db: {} as Db, router: {} as ModelRouter };
afterEach(() => resetConfigForTest());
describe('chat provider configuration gate', () => {
  it('allows ADC-backed Vertex without an OpenRouter key', async () => {
    const config = loadConfig({
      LLM_PROVIDER: 'vertex',
      VERTEX_PROJECT: 'customer-project',
      VERTEX_LOCATION: 'global',
      OPENROUTER_API_KEY: '',
    });
    const response = await handleChatTurn(request(), { ...unused, config });
    expect(response.status).toBe(400);
  });
  it('rejects missing Vertex identity before accessing persistence', async () => {
    const config = loadConfig({
      LLM_PROVIDER: 'vertex',
      VERTEX_PROJECT: '',
      VERTEX_LOCATION: '',
      OPENROUTER_API_KEY: 'irrelevant-key',
    });
    const response = await handleChatTurn(request(), { ...unused, config });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'not_configured' });
  });
  it('preserves the default OpenRouter credential requirement', async () => {
    const config = loadConfig({ OPENROUTER_API_KEY: '' });
    const response = await handleChatTurn(request(), { ...unused, config });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('OPENROUTER_API_KEY'),
    });
  });
});
